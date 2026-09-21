import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";

/**
 * DeepgramSTT — Streaming Speech-to-Text using Deepgram's WebSocket API.
 *
 * Deepgram is the default STT provider because:
 * - Sub-300ms latency for streaming recognition
 * - Excellent accuracy with Nova-2 model
 * - Native WebSocket API (no HTTP polling)
 * - Supports interim results for real-time feedback
 */
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
    return new DeepgramSTTStream({
      apiKey: this.apiKey,
      model: this.model,
      baseUrl: this.baseUrl,
      language: options?.language ?? "en-US",
      interimResults: options?.interimResults ?? true,
      keywords: options?.keywords,
    });
  }
}

class DeepgramSTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket | null = null;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private readonly config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    language: string;
    interimResults: boolean;
    keywords?: string[];
  };
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    language: string;
    interimResults: boolean;
    keywords?: string[];
  }) {
    super();
    this.config = config;
    this.connectPromise = this.connect();
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
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
        },
      });

      this.ws.on("open", () => {
        this.connected = true;
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const response = JSON.parse(data.toString());
          this.handleResponse(response);
        } catch {
          // Ignore non-JSON messages
        }
      });

      this.ws.on("error", (error) => {
        console.error("[STT/Deepgram] WebSocket error:", error.message);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  write(chunk: AudioChunk): void {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk.data);
    }
  }

  onResult(handler: (result: STTResult) => void): void {
    this.resultHandler = handler;
  }

  async close(): Promise<void> {
    if (this.ws) {
      // Send close message per Deepgram protocol
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private handleResponse(response: Record<string, unknown>): void {
    // Deepgram response format
    if (response.type === "Results") {
      const channel = (response as any).channel;
      if (!channel?.alternatives?.length) return;

      const alt = channel.alternatives[0];
      const result: STTResult = {
        text: alt.transcript ?? "",
        isFinal: (response as any).is_final ?? false,
        confidence: alt.confidence ?? 0,
        words: alt.words?.map((w: any) => ({
          word: w.word,
          startMs: Math.round(w.start * 1000),
          endMs: Math.round(w.end * 1000),
        })),
      };

      // Only emit non-empty results
      if (result.text.trim()) {
        this.resultHandler?.(result);
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
