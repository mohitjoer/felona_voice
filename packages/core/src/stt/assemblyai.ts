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

export interface AssemblyAISTTOptions {
  apiKey: string;
  sampleRate?: number;
  baseUrl?: string;
  wordBoost?: string[];
  encoding?: string;
  /**
   * Handshake deadline before the stream gives up. Default: 10000ms.
   *
   * A socket that stays in CONNECTING forever would otherwise hold the turn
   * — and the teardown that follows it — open indefinitely.
   */
  connectTimeoutMs?: number;
}

/**
 * AssemblyAISTT — Streaming real-time Speech-to-Text using AssemblyAI WebSocket API.
 */
export class AssemblyAISTT implements STTProvider {
  readonly name = "assemblyai";
  private readonly options: AssemblyAISTTOptions;

  constructor(options: AssemblyAISTTOptions) {
    this.options = {
      sampleRate: 16000,
      baseUrl: "wss://api.assemblyai.com/v2/realtime/ws",
      ...options,
    };
  }

  createStream(options?: STTStreamOptions): STTStream {
    if (!this.options.apiKey) {
      throw new MissingCredentialsError(
        "assemblyai",
        'stt: { provider: "assemblyai", apiKey: process.env.ASSEMBLYAI_API_KEY }',
      );
    }
    return new AssemblyAISTTStream({
      apiKey: this.options.apiKey,
      sampleRate: this.options.sampleRate ?? 16000,
      baseUrl: this.options.baseUrl ?? "wss://api.assemblyai.com/v2/realtime/ws",
      wordBoost: options?.keywords ?? this.options.wordBoost,
      encoding: this.options.encoding ?? "pcm_s16le",
      flushTimeoutMs: options?.flushTimeoutMs,
      connectTimeoutMs: this.options.connectTimeoutMs,
    });
  }
}

class AssemblyAISTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket | null = null;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private readonly config: {
    apiKey: string;
    sampleRate: number;
    baseUrl: string;
    wordBoost?: string[];
    encoding: string;
    flushTimeoutMs: number;
    connectTimeoutMs: number;
  };
  private connected = false;
  private isClosed = false;
  private finalWaiters: Array<() => void> = [];
  /** Resolves when the socket opens, rejects if it fails before that. */
  private connectPromise: Promise<void>;
  private resolveConnect!: () => void;
  private rejectConnect!: (error: Error) => void;
  private connectSettled = false;
  private connectTimer?: NodeJS.Timeout;
  /** Audio written before the socket opened, replayed once it connects. */
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;

  private static readonly MAX_PENDING_AUDIO_BYTES = 64000; // ~1s at 16kHz mono 16-bit
  /**
   * How long to wait for the handshake before giving up. A socket that sits
   * in CONNECTING forever must not hold `close()` open indefinitely, and a
   * provider that never completes the handshake is a failure the caller needs
   * to hear about rather than a turn that silently routes on nothing.
   */
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  constructor(config: {
    apiKey: string;
    sampleRate: number;
    baseUrl: string;
    wordBoost?: string[];
    encoding: string;
    flushTimeoutMs?: number;
    connectTimeoutMs?: number;
  }) {
    super();
    this.config = {
      ...config,
      flushTimeoutMs: config.flushTimeoutMs ?? 1500,
      connectTimeoutMs: config.connectTimeoutMs ?? AssemblyAISTTStream.CONNECT_TIMEOUT_MS,
    };    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    // A caller that never awaits this must not trip the unhandled-rejection
    // guard; real errors are reported through `errorHandler`.
    this.connectPromise.catch(() => {});
    this.connect();
  }

  private connect(): void {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set("sample_rate", String(this.config.sampleRate));
    if (this.config.wordBoost?.length) {
      url.searchParams.set("word_boost", JSON.stringify(this.config.wordBoost));
    }

    this.ws = new WebSocket(url.toString(), {
      headers: {
        Authorization: this.config.apiKey,
      },
    });

    this.ws.on("open", () => {
      this.connected = true;
      this.settleConnect(() => this.resolveConnect());
      // Replay what the caller said before the handshake finished, otherwise
      // the first second of every call is silently lost.
      const pending = this.pendingAudio;
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      for (const audio of pending) this.sendAudio(audio);
    });

    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch {
        // Ignore non-JSON
      }
    });

    this.ws.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.settleConnect(() => this.rejectConnect(err));
      this.reportError(err);
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.settleConnect(() =>
        this.rejectConnect(new Error("STT/AssemblyAI socket closed before connecting")),
      );
      this.releaseFinalWaiters();
    });

    // A handshake that never completes must not wedge the turn or the
    // teardown that follows it.
    this.connectTimer = setTimeout(() => {
      if (this.connectSettled) return;
      this.settleConnect(() =>
        this.rejectConnect(
          new Error(
            `STT/AssemblyAI did not connect within ${this.config.connectTimeoutMs}ms`,
          ),
        ),
      );
      // Tear the half-open socket down; nothing useful can come of it.
      try {
        this.ws?.terminate();
      } catch {
        // Already gone.
      }
    }, this.config.connectTimeoutMs);
    this.connectTimer.unref?.();
  }

  /**
   * Settles `connectPromise` exactly once and disarms its timer.
   *
   * Every terminal handshake path funnels through here so the promise cannot
   * be left pending — which would hang `close()` and leak the socket.
   */
  private settleConnect(settle: () => void): void {
    if (this.connectSettled) return;
    this.connectSettled = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    settle();
  }

  private reportError(err: Error): void {
    if (this.errorHandler) {
      this.errorHandler(err);
    } else {
      console.error("[STT/AssemblyAI]", err.message);
    }
  }

  /** Resolves once the socket is open, or rejects if it never does. */
  private ready(): Promise<void> {
    return this.connectPromise;
  }

  private releaseFinalWaiters(): void {
    const waiters = this.finalWaiters;
    this.finalWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private sendAudio(data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ audio_data: data.toString("base64") }));
  }

  write(chunk: AudioChunk): void {
    if (this.isClosed) return;

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendAudio(chunk.data);
      return;
    }

    // Buffer audio captured during the handshake so the opening words survive.
    this.pendingAudio.push(chunk.data);
    this.pendingAudioBytes += chunk.data.length;
    while (
      this.pendingAudioBytes > AssemblyAISTTStream.MAX_PENDING_AUDIO_BYTES &&
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
   * Wait for AssemblyAI's endpointing final transcript for the current turn.
   *
   * A turn can close before the handshake completes. Returning immediately in
   * that window would submit an empty transcript and route on nothing, so we
   * wait for the socket first.
   */
  async flush(): Promise<void> {
    if (this.isClosed) return;
    if (!this.connected) {
      await this.ready().catch(() => {});
      if (this.isClosed) return;
    }
    if (!this.connected) return;

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

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.releaseFinalWaiters();

    // The previous teardown was gated on readyState === OPEN, so a call that
    // ended mid-handshake left the socket open with its listeners attached.
    if (this.ws) {
      // Let a pending handshake settle so we do not leak the promise.
      await this.connectPromise.catch(() => {});
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ terminate_session: true }));
        } catch {
          // Ignore errors during termination
        }
        ws.close();
      } else {
        // Still CONNECTING: close() would not fire a close event for a socket
        // that never opened, so terminate it outright.
        ws.terminate();
      }
    }
    this.connected = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const msgType = msg.message_type;

    if (msgType === "PartialTranscript" || msgType === "FinalTranscript") {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) return;

      const isFinal = msgType === "FinalTranscript";
      const confidence = typeof msg.confidence === "number" ? msg.confidence : 0.9;

      const words = Array.isArray(msg.words)
        ? (msg.words as Array<{ text?: string; start?: number; end?: number }>).map((w) => ({
            word: w.text ?? "",
            startMs: w.start ?? 0,
            endMs: w.end ?? 0,
          }))
        : undefined;

      this.resultHandler?.({
        text,
        isFinal,
        confidence: Number(confidence.toFixed(3)),
        words,
      });

      if (isFinal) this.releaseFinalWaiters();
    }
  }
}

export function createAssemblyAISTT(options: AssemblyAISTTOptions): AssemblyAISTT {
  return new AssemblyAISTT(options);
}
