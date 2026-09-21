import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";

export interface GoogleSTTOptions {
  apiKey: string;
  languageCode?: string;
  model?: string;
  enableWordTimeOffsets?: boolean;
}

/**
 * GoogleSTT — Speech-to-Text using Google Cloud Speech-to-Text v1 REST API.
 */
export class GoogleSTT implements STTProvider {
  readonly name = "google";
  private readonly options: GoogleSTTOptions;

  constructor(options: GoogleSTTOptions) {
    this.options = {
      languageCode: "en-US",
      model: "default",
      enableWordTimeOffsets: true,
      ...options,
    };
  }

  createStream(options?: STTStreamOptions): STTStream {
    return new GoogleSTTStream({
      ...this.options,
      languageCode: options?.language ?? this.options.languageCode ?? "en-US",
      keywords: options?.keywords,
    });
  }
}

class GoogleSTTStream extends EventEmitter implements STTStream {
  private chunks: Buffer[] = [];
  private resultHandler: ((result: STTResult) => void) | null = null;
  private isClosed = false;
  private readonly config: GoogleSTTOptions & { keywords?: string[] };

  constructor(config: GoogleSTTOptions & { keywords?: string[] }) {
    super();
    this.config = config;
  }

  write(chunk: AudioChunk): void {
    if (this.isClosed) return;
    this.chunks.push(chunk.data);
  }

  onResult(handler: (result: STTResult) => void): void {
    this.resultHandler = handler;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.chunks.length === 0) return;

    const fullPcm = Buffer.concat(this.chunks);
    this.chunks = [];

    // Skip tiny audio (< 0.2s)
    if (fullPcm.length < 3200) return;

    const base64Audio = fullPcm.toString("base64");
    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${this.config.apiKey}`;

    const speechContexts = this.config.keywords?.length
      ? [{ phrases: this.config.keywords }]
      : undefined;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            languageCode: this.config.languageCode ?? "en-US",
            model: this.config.model ?? "default",
            enableWordTimeOffsets: this.config.enableWordTimeOffsets ?? true,
            speechContexts,
          },
          audio: {
            content: base64Audio,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[STT/Google] Recognition error ${res.status}: ${err}`);
        return;
      }

      const data = (await res.json()) as {
        results?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
            words?: Array<{
              word: string;
              startTime?: string;
              endTime?: string;
            }>;
          }>;
        }>;
      };

      const topResult = data.results?.[0]?.alternatives?.[0];
      if (!topResult?.transcript) return;

      const text = topResult.transcript.trim();
      const confidence = topResult.confidence ?? 0.9;

      const parseTime = (tStr?: string): number => {
        if (!tStr) return 0;
        return Math.round(parseFloat(tStr.replace("s", "")) * 1000);
      };

      const words = topResult.words?.map((w) => ({
        word: w.word,
        startMs: parseTime(w.startTime),
        endMs: parseTime(w.endTime),
      }));

      this.resultHandler?.({
        text,
        isFinal: true,
        confidence: Number(confidence.toFixed(3)),
        words,
      });
    } catch (err) {
      console.error("[STT/Google] Transcription failed:", err);
    }
  }
}

export function createGoogleSTT(options: GoogleSTTOptions): GoogleSTT {
  return new GoogleSTT(options);
}
