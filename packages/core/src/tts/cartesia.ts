import { streamPcm } from "./stream-pcm.js";
import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

export interface CartesiaTTSOptions {
  apiKey: string;
  voice?: string;
  modelId?: string;
  baseUrl?: string;
  sampleRate?: 8000 | 16000 | 22050 | 24000 | 44100;
}

/**
 * CartesiaTTS — Ultra-low-latency streaming Text-to-Speech using Cartesia's Sonic API (<100ms TTFB).
 */
export class CartesiaTTS implements TTSProvider {
  readonly name = "cartesia";
  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly sampleRate: number;

  constructor(options: CartesiaTTSOptions) {
    this.apiKey = options.apiKey;
    // Default to popular sonic voice (e.g. Sonic English default ID or voice string)
    this.defaultVoice = options.voice ?? "a0e99841-438c-4a64-b679-ae501e7d6091";
    this.modelId = options.modelId ?? "sonic-english";
    this.baseUrl = options.baseUrl ?? "https://api.cartesia.ai";
    this.sampleRate = options.sampleRate ?? 16000;
  }

  async *synthesize(
    text: string,
    options?: TTSOptions
  ): AsyncIterable<AudioChunk> {
    const voiceId = options?.voice ?? this.defaultVoice;

    yield* streamPcm(
      `${this.baseUrl}/tts/bytes`,
      {
        method: "POST",
        headers: {
        "X-API-Key": this.apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
        body: JSON.stringify({
        model_id: this.modelId,
        transcript: text,
        voice: {
          mode: "id",
          id: voiceId,
        },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: this.sampleRate,
        },
      }),
      },
      {
        sampleRate: this.sampleRate,
        providerLabel: "Cartesia TTS",
        signal: options?.signal,
      },
    );
  }
}

export function createCartesiaTTS(options: CartesiaTTSOptions): CartesiaTTS {
  return new CartesiaTTS(options);
}
