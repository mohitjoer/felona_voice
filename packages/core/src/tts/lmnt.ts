import { streamPcm } from "./stream-pcm.js";
import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

export interface LMNTTTSOptions {
  apiKey: string;
  voice?: string;
  baseUrl?: string;
  sampleRate?: 8000 | 16000 | 24000;
  speed?: number;
}

/**
 * LMNTTTS — Low-latency streaming Text-to-Speech using LMNT API.
 */
export class LMNTTTS implements TTSProvider {
  readonly name = "lmnt";
  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly baseUrl: string;
  private readonly sampleRate: number;
  private readonly speed: number;

  constructor(options: LMNTTTSOptions) {
    this.apiKey = options.apiKey;
    this.defaultVoice = options.voice ?? "lily";
    this.baseUrl = options.baseUrl ?? "https://api.lmnt.com/v1";
    this.sampleRate = options.sampleRate ?? 16000;
    this.speed = options.speed ?? 1.0;
  }

  async *synthesize(
    text: string,
    options?: TTSOptions
  ): AsyncIterable<AudioChunk> {
    const voice = options?.voice ?? this.defaultVoice;
    const speed = options?.speed ?? this.speed;

    yield* streamPcm(
      `${this.baseUrl}/ai/speech/stream`,
      {
        method: "POST",
        headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
        body: JSON.stringify({
        text,
        voice,
        format: "raw", // linear16 PCM
        sample_rate: this.sampleRate,
        speed,
      }),
      },
      {
        sampleRate: this.sampleRate,
        providerLabel: "LMNT TTS",
        signal: options?.signal,
      },
    );
  }
}

export function createLMNTTTS(options: LMNTTTSOptions): LMNTTTS {
  return new LMNTTTS(options);
}
