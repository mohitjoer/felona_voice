import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";

export interface AssemblyAISTTOptions {
  apiKey: string;
  sampleRate?: number;
  baseUrl?: string;
  wordBoost?: string[];
  encoding?: string;
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
    return new AssemblyAISTTStream({
      apiKey: this.options.apiKey,
      sampleRate: this.options.sampleRate ?? 16000,
      baseUrl: this.options.baseUrl ?? "wss://api.assemblyai.com/v2/realtime/ws",
      wordBoost: options?.keywords ?? this.options.wordBoost,
      encoding: this.options.encoding ?? "pcm_s16le",
    });
  }
}

class AssemblyAISTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket | null = null;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private readonly config: {
    apiKey: string;
    sampleRate: number;
    baseUrl: string;
    wordBoost?: string[];
    encoding: string;
  };
  private connected = false;
  private isClosed = false;

  constructor(config: {
    apiKey: string;
    sampleRate: number;
    baseUrl: string;
    wordBoost?: string[];
    encoding: string;
  }) {
    super();
    this.config = config;
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
      console.error("[STT/AssemblyAI] WebSocket error:", error.message);
    });

    this.ws.on("close", () => {
      this.connected = false;
    });
  }

  write(chunk: AudioChunk): void {
    if (this.isClosed || !this.ws || !this.connected || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = JSON.stringify({
      audio_data: chunk.data.toString("base64"),
    });
    this.ws.send(payload);
  }

  onResult(handler: (result: STTResult) => void): void {
    this.resultHandler = handler;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ terminate_session: true }));
      } catch {
        // Ignore errors during termination
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private handleMessage(msg: Record<string, any>): void {
    const msgType = msg.message_type;

    if (msgType === "PartialTranscript" || msgType === "FinalTranscript") {
      const text = (msg.text || "").trim();
      if (!text) return;

      const isFinal = msgType === "FinalTranscript";
      const confidence = typeof msg.confidence === "number" ? msg.confidence : 0.9;

      const words = Array.isArray(msg.words)
        ? msg.words.map((w: any) => ({
            word: w.text,
            startMs: w.start,
            endMs: w.end,
          }))
        : undefined;

      this.resultHandler?.({
        text,
        isFinal,
        confidence: Number(confidence.toFixed(3)),
        words,
      });
    }
  }
}

export function createAssemblyAISTT(options: AssemblyAISTTOptions): AssemblyAISTT {
  return new AssemblyAISTT(options);
}
