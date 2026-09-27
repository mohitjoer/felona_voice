import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";
import { MissingCredentialsError } from "./credentials.js";

/**
 * DeepgramSTT — Streaming Speech-to-Text using Deepgram's WebSocket API.
 *
 * Deepgram is the default STT provider because:
 * - Sub-300ms latency for streaming recognition
 * - Excellent accuracy with Nova-2 model
 * - Native WebSocket API (no HTTP polling)
 * - Supports interim results for real-time feedback
 */
/** Shape of the Deepgram `Results` message we consume. */
interface DeepgramResultsMessage {
  type?: string;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: Array<{ word: string; start: number; end: number }>;
    }>;
  };
}

export class DeepgramSTT implements STTProvider {
  readonly name = "deepgram";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "nova-2";
    this.baseUrl =
      options.baseUrl ?? "wss://api.deepgram.com/v1/listen";
  }

  createStream(options?: STTStreamOptions): STTStream {
    if (!this.apiKey) {
      throw new MissingCredentialsError(
        "deepgram",
        "stt: { provider: \"deepgram\", apiKey: process.env.DEEPGRAM_API_KEY }",
      );
    }
    return new DeepgramSTTStream({
      apiKey: this.apiKey,
      model: this.model,
      baseUrl: this.baseUrl,
      language: options?.language ?? "en-US",
      interimResults: options?.interimResults ?? true,
      keywords: options?.keywords,
      flushTimeoutMs: options?.flushTimeoutMs,
    });
  }
}

class DeepgramSTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket | null = null;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private readonly config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    language: string;
    interimResults: boolean;
    keywords?: string[];
    flushTimeoutMs: number;
  };
  private connected = false;
  private closed = false;
  private connectPromise: Promise<void>;
  /** Audio written before the socket opened, replayed once it connects. */
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  /** Resolvers waiting for the next final result (see `flush`). */
  private finalWaiters: Array<() => void> = [];

  private static readonly MAX_PENDING_AUDIO_BYTES = 64000; // ~1s at 16kHz mono 16-bit

  constructor(config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    language: string;
    interimResults: boolean;
    keywords?: string[];
    flushTimeoutMs?: number;
  }) {
    super();
    this.config = { ...config, flushTimeoutMs: config.flushTimeoutMs ?? 1500 };
    this.connectPromise = this.connect();

    // The pipeline does not await the connection (it is created per call and
    // audio must be accepted immediately), so a failed handshake — bad API
    // key, network error — has to be absorbed here. Without this, the
    // rejection is unhandled and takes the whole process down.
    this.connectPromise.catch(() => {
      // Reported through `onError`; see `fail`.
    });
  }

  /** Resolve once the socket is open (or has permanently failed). */
  ready(): Promise<void> {
    return this.connectPromise.catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      interim_results: String(this.config.interimResults),
      punctuate: "true",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
    });

    if (this.config.keywords?.length) {
      for (const kw of this.config.keywords) {
        params.append("keywords", kw);
      }
    }

    const url = `${this.config.baseUrl}?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
        },
      });
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.flushPendingAudio();
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const response = JSON.parse(data.toString());
          this.handleResponse(response);
        } catch {
          // Ignore non-JSON messages
        }
      });

      ws.on("error", (error) => {
        const err =
          error instanceof Error ? error : new Error(String(error));
        if (!this.connected) {
          reject(err);
        }
        this.fail(err);
      });

      ws.on("close", () => {
        this.connected = false;
        this.releaseFinalWaiters();
      });
    });
  }

  /** Surface a stream failure without emitting a fatal `error` event. */
  private fail(error: Error): void {
    if (this.errorHandler) {
      this.errorHandler(error);
    } else {
      console.error("[STT/Deepgram]", error.message);
    }
  }

  private flushPendingAudio(): void {
    if (this.pendingAudio.length === 0 || !this.ws) return;
    for (const buf of this.pendingAudio) {
      this.ws.send(buf);
    }
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  write(chunk: AudioChunk): void {
    if (this.closed || !this.ws) return;

    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk.data);
      return;
    }

    // Buffer audio captured while the handshake is still in flight so the
    // first words of a call are not lost.
    this.pendingAudio.push(chunk.data);
    this.pendingAudioBytes += chunk.data.length;
    while (
      this.pendingAudioBytes > DeepgramSTTStream.MAX_PENDING_AUDIO_BYTES &&
      this.pendingAudio.length > 1
    ) {
      const dropped = this.pendingAudio.shift();
      this.pendingAudioBytes -= dropped?.length ?? 0;
    }
  }

  onResult(handler: (result: STTResult) => void): void {
    this.resultHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Wait for the recognizer's next final result.
   *
   * Deliberately does *not* send Deepgram's `Finalize` message: that ends the
   * stream, and the pipeline keeps one stream for the whole call. Instead we
   * wait for the endpointing final, which Deepgram emits on its own once the
   * speaker stops.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (!this.connected) {
      await this.ready();
      if (!this.connected) return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finalWaiters = this.finalWaiters.filter((w) => w !== done);
        resolve();
      };

      const timer = setTimeout(done, this.config.flushTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.finalWaiters.push(done);
    });
  }

  private releaseFinalWaiters(): void {
    const waiters = this.finalWaiters;
    this.finalWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.releaseFinalWaiters();

    const ws = this.ws;
    this.ws = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;

    if (!ws) return;

    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        // Socket already gone — nothing to close cleanly.
      }
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 250);
      if (typeof timer.unref === "function") timer.unref();
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.connected = false;
  }

  private handleResponse(response: Record<string, unknown>): void {
    // Deepgram response format
    if (response.type === "Results") {
      const message = response as DeepgramResultsMessage;
      const channel = message.channel;
      const alt = channel?.alternatives?.[0];
      if (!alt) return;

      const result: STTResult = {
        text: alt.transcript ?? "",
        isFinal: message.is_final ?? false,
        confidence: alt.confidence ?? 0,
        words: alt.words?.map((w) => ({
          word: w.word,
          startMs: Math.round(w.start * 1000),
          endMs: Math.round(w.end * 1000),
        })),
      };

      // Only emit non-empty results
      if (result.text.trim()) {
        this.resultHandler?.(result);
        if (result.isFinal) this.releaseFinalWaiters();
      }
    }
  }
}

export function createDeepgramSTT(options: {
  apiKey: string;
  model?: string;
}): DeepgramSTT {
  return new DeepgramSTT(options);
}
