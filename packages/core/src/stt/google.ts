import { EventEmitter } from "node:events";
import { AudioBuffer } from "./audio-buffer.js";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";
import { MissingCredentialsError } from "./credentials.js";

export interface GoogleSTTOptions {
  apiKey: string;
  languageCode?: string;
  model?: string;
  enableWordTimeOffsets?: boolean;
  /** Deadline for a single recognition request. Default: 15000ms. */
  timeoutMs?: number;
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
    if (!this.options.apiKey) {
      throw new MissingCredentialsError(
        "google",
        'stt: { provider: "google", apiKey: process.env.GOOGLE_API_KEY }',
      );
    }
    return new GoogleSTTStream({
      ...this.options,
      languageCode: options?.language ?? this.options.languageCode ?? "en-US",
      keywords: options?.keywords,
    });
  }
}

class GoogleSTTStream extends EventEmitter implements STTStream {
  private readonly buffer: AudioBuffer;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private isClosed = false;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly config: GoogleSTTOptions & { keywords?: string[] };

  constructor(config: GoogleSTTOptions & { keywords?: string[] }) {
    super();
    this.config = config;
    this.buffer = new AudioBuffer({
      onDrop: (bytes) =>
        this.reportError(
          `audio buffer cap reached, discarded ${bytes} bytes of oldest audio`,
          new Error("buffer overflow"),
        ),
    });
  }

  write(chunk: AudioChunk): void {
    if (this.isClosed) return;
    this.buffer.push(chunk.data);
  }

  onResult(handler: (result: STTResult) => void): void {
    this.resultHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private reportError(context: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    // The context carries the diagnosis (status, overflow size); the
    // detail is only the provider's own message. Both belong in what
    // the handler sees, otherwise a 401 is indistinguishable from a
    // rate limit.
    const error = new Error(detail ? `${context}: ${detail}` : context);
    if (this.errorHandler) {
      this.errorHandler(error);
    } else {
      console.error(`[STT/Google] ${context}: ${detail}`);
    }
  }

  /**
   * Recognize everything buffered so far.
   *
   * Google has no streaming endpoint, so the pipeline calls this when the user
   * stops speaking to get a result mid-call.
   */
  async flush(): Promise<void> {
    // Recover from a prior rejection: chaining onto a rejected promise would
    // make every later flush — and close(), which flushes — reject too.
    const previous = this.inFlight.catch(() => {});
    this.inFlight = previous.then(() => this.recognize());
    await this.inFlight;
  }

  private async recognize(): Promise<void> {
    if (this.buffer.isEmpty) return;

    const fullPcm = this.buffer.take();

    // Skip tiny audio (< 0.2s)
    if (fullPcm.length < 3200) return;

    const base64Audio = fullPcm.toString("base64");
    const url =
      "https://speech.googleapis.com/v1/speech:recognize";

    const speechContexts = this.config.keywords?.length
      ? [{ phrases: this.config.keywords }]
      : undefined;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Sent as a header rather than `?key=`: query strings land in proxy
          // logs, CDN logs and error messages, and a leaked key is a leaked key.
          "X-Goog-Api-Key": this.config.apiKey,
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
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        this.reportError(
          `recognition failed (${res.status}${
            res.status === 401 || res.status === 403
              ? " — check the Google Cloud API key"
              : res.status === 429
                ? " — rate limited"
                : ""
          })`,
          new Error(err || res.statusText),
        );
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
      this.reportError("transcription failed", err);
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.flush();
  }
}

export function createGoogleSTT(options: GoogleSTTOptions): GoogleSTT {
  return new GoogleSTT(options);
}
