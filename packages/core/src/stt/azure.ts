import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";
import { pcmToWav } from "./wav.js";
import { AudioBuffer } from "./audio-buffer.js";
import { MissingCredentialsError } from "./credentials.js";

export interface AzureSTTOptions {
  apiKey: string;
  region: string;
  language?: string;
  format?: "simple" | "detailed";
  profanity?: "masked" | "removed" | "raw";
  /** Deadline for a single recognition request. Default: 15000ms. */
  timeoutMs?: number;
  /** Server-side denoising. Off by default. */
  noiseReduction?: "off" | "light" | "medium" | "heavy";
  /** Microsoft's speech enhancement, which also improves far-field audio. */
  speechEnhancement?: "disable" | "quality";
}

/**
 * AzureSTT — Speech-to-Text using Azure Cognitive Services Speech API.
 */
export class AzureSTT implements STTProvider {
  readonly name = "azure";
  private readonly options: AzureSTTOptions;

  constructor(options: AzureSTTOptions) {
    this.options = {
      language: "en-US",
      format: "detailed",
      profanity: "masked",
      ...options,
    };
  }

  createStream(options?: STTStreamOptions): STTStream {
    if (!this.options.apiKey) {
      throw new MissingCredentialsError(
        "azure",
        'stt: { provider: "azure", apiKey, region: "eastus" }',
      );
    }
    return new AzureSTTStream({
      ...this.options,
      language: options?.language ?? this.options.language ?? "en-US",
    });
  }
}

class AzureSTTStream extends EventEmitter implements STTStream {
  private readonly buffer: AudioBuffer;
  private resultHandler: ((result: STTResult) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private isClosed = false;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly config: AzureSTTOptions;

  constructor(config: AzureSTTOptions) {
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
      console.error(`[STT/Azure] ${context}: ${detail}`);
    }
  }

  /**
   * Recognize everything buffered so far.
   *
   * Azure's batch endpoint has no streaming equivalent, so the pipeline calls
   * this when the user stops speaking to get a result mid-call.
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

    const wavBuffer = pcmToWav(fullPcm, 16000, 1, 16);

    const url = new URL(
      `https://${this.config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
    );
    url.searchParams.set("language", this.config.language ?? "en-US");
    url.searchParams.set("format", this.config.format ?? "detailed");
    if (this.config.profanity) {
      url.searchParams.set("profanity", this.config.profanity);
    }
    // Server-side denoising. Off by default: it costs extra per hour and can
    // attenuate consonants on a clean line, so it is the operator's call.
    if (this.config.noiseReduction) {
      url.searchParams.set(
        "noiseReduction",
        String(this.config.noiseReduction),
      );
    }
    if (this.config.speechEnhancement) {
      url.searchParams.set(
        "speechEnhancement",
        String(this.config.speechEnhancement),
      );
    }

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.config.apiKey,
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          Accept: "application/json",
        },
        body: wavBuffer,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        this.reportError(
          `recognition failed (${res.status}${
            res.status === 401 || res.status === 403
              ? " — check the Azure subscription key"
              : res.status === 429
                ? " — rate limited"
                : ""
          })`,
          new Error(err || res.statusText),
        );
        return;
      }

      const data = (await res.json()) as {
        RecognitionStatus?: string;
        DisplayText?: string;
        NBest?: Array<{
          Display?: string;
          Confidence?: number;
          Words?: Array<{ Word: string; Offset: number; Duration: number }>;
        }>;
      };

      if (data.RecognitionStatus === "Success") {
        const topResult = data.NBest?.[0];
        const text = (topResult?.Display ?? data.DisplayText ?? "").trim();
        if (!text) return;

        const confidence = topResult?.Confidence ?? 0.9;
        const words = topResult?.Words?.map((w) => ({
          word: w.Word,
          startMs: Math.round(w.Offset / 10000), // Azure offsets are in 100-nanosecond units (ticks)
          endMs: Math.round((w.Offset + w.Duration) / 10000),
        }));

        this.resultHandler?.({
          text,
          isFinal: true,
          confidence: Number(confidence.toFixed(3)),
          words,
        });
      }
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

export function createAzureSTT(options: AzureSTTOptions): AzureSTT {
  return new AzureSTT(options);
}
