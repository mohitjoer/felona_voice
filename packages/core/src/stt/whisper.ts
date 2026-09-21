import { EventEmitter } from "node:events";
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  AudioChunk,
} from "../types.js";
import { pcmToWav } from "./wav.js";

export interface WhisperSTTOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  temperature?: number;
  prompt?: string;
}

/**
 * WhisperSTT — Speech-to-Text using OpenAI's Whisper API (`whisper-1`).
 *
 * Buffers incoming linear PCM audio chunks and dispatches them to OpenAI's
 * `/v1/audio/transcriptions` endpoint when the utterance finishes or the stream closes.
 */
export class WhisperSTT implements STTProvider {
  readonly name = "whisper";
  private readonly options: WhisperSTTOptions;

  constructor(options: WhisperSTTOptions) {
    this.options = {
      model: "whisper-1",
      baseUrl: "https://api.openai.com/v1",
      ...options,
    };
  }

  createStream(options?: STTStreamOptions): STTStream {
    return new WhisperSTTStream({
      ...this.options,
      language: options?.language ?? this.options.language,
      keywords: options?.keywords,
    });
  }
}

class WhisperSTTStream extends EventEmitter implements STTStream {
  private chunks: Buffer[] = [];
  private resultHandler: ((result: STTResult) => void) | null = null;
  private isClosed = false;
  private readonly config: WhisperSTTOptions & { keywords?: string[] };

  constructor(config: WhisperSTTOptions & { keywords?: string[] }) {
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

    // Skip empty or tiny audio bursts (< 0.2s of audio at 16kHz mono 16-bit = 6400 bytes)
    if (fullPcm.length < 3200) return;

    const wavBuffer = pcmToWav(fullPcm, 16000, 1, 16);

    try {
      const formData = new FormData();
      const audioBlob = new Blob([wavBuffer], { type: "audio/wav" });
      formData.append("file", audioBlob, "audio.wav");
      formData.append("model", this.config.model ?? "whisper-1");
      formData.append("response_format", "verbose_json");

      if (this.config.language) {
        // Strip country code if present (e.g. en-US -> en)
        const lang = this.config.language.split("-")[0].toLowerCase();
        formData.append("language", lang);
      }

      if (this.config.prompt) {
        formData.append("prompt", this.config.prompt);
      } else if (this.config.keywords?.length) {
        formData.append("prompt", this.config.keywords.join(", "));
      }

      if (this.config.temperature !== undefined) {
        formData.append("temperature", String(this.config.temperature));
      }

      const res = await fetch(`${this.config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[STT/Whisper] Transcription error ${res.status}: ${errText}`);
        return;
      }

      const data = (await res.json()) as {
        text?: string;
        segments?: Array<{ avg_logprob?: number }>;
        words?: Array<{ word: string; start: number; end: number }>;
      };

      const text = data.text?.trim() ?? "";
      if (!text) return;

      // Estimate confidence from avg_logprob if available (logprob -> probability = e^logprob)
      let confidence = 0.95;
      if (data.segments && data.segments.length > 0 && typeof data.segments[0].avg_logprob === "number") {
        confidence = Math.min(1, Math.max(0.1, Math.exp(data.segments[0].avg_logprob)));
      }

      const words = data.words?.map((w) => ({
        word: w.word,
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      }));

      this.resultHandler?.({
        text,
        isFinal: true,
        confidence: Number(confidence.toFixed(3)),
        words,
      });
    } catch (err) {
      console.error("[STT/Whisper] Failed to transcribe audio:", err);
    }
  }
}

export function createWhisperSTT(options: WhisperSTTOptions): WhisperSTT {
  return new WhisperSTT(options);
}
