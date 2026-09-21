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

    const response = await fetch(`${this.baseUrl}/ai/speech/stream`, {
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
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LMNT TTS failed: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("LMNT TTS returned no response body");
    }

    const reader = response.body.getReader();
    let timestampMs = 0;
    const bytesPerSecond = this.sampleRate * 2;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk: AudioChunk = {
          data: Buffer.from(value),
          sampleRate: this.sampleRate,
          channels: 1,
          bitDepth: 16,
          timestampMs,
        };

        timestampMs += (value.length / bytesPerSecond) * 1000;
        yield chunk;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function createLMNTTTS(options: LMNTTTSOptions): LMNTTTS {
  return new LMNTTTS(options);
}
