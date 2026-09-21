import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

export interface PollyTTSOptions {
  /** AWS Region (e.g. "us-east-1") */
  region?: string;
  /** Neural voice ID (e.g. "Joanna", "Matthew", "Ruth", "Amy") */
  voice?: string;
  /** Custom endpoint URL or signed endpoint */
  endpointUrl?: string;
  /** Bearer or Authorization header token if calling via API gateway / proxy */
  apiKey?: string;
  engine?: "neural" | "standard" | "generative" | "long-form";
  sampleRate?: 8000 | 16000;
}

/**
 * PollyTTS — Streaming Text-to-Speech using Amazon Polly (Neural / Generative voices).
 */
export class PollyTTS implements TTSProvider {
  readonly name = "polly";
  private readonly defaultVoice: string;
  private readonly region: string;
  private readonly engine: string;
  private readonly sampleRate: number;
  private readonly endpointUrl: string;
  private readonly apiKey?: string;

  constructor(options?: PollyTTSOptions) {
    this.region = options?.region ?? "us-east-1";
    this.defaultVoice = options?.voice ?? "Joanna";
    this.engine = options?.engine ?? "neural";
    this.sampleRate = options?.sampleRate ?? 16000;
    this.endpointUrl =
      options?.endpointUrl ??
      `https://polly.${this.region}.amazonaws.com/v1/speech`;
    this.apiKey = options?.apiKey;
  }

  async *synthesize(
    text: string,
    options?: TTSOptions
  ): AsyncIterable<AudioChunk> {
    const voiceId = options?.voice ?? this.defaultVoice;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = this.apiKey.startsWith("Bearer ")
        ? this.apiKey
        : `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        OutputFormat: "pcm",
        SampleRate: String(this.sampleRate),
        Text: text,
        VoiceId: voiceId,
        Engine: this.engine,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`AWS Polly TTS failed: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("AWS Polly TTS returned no response body");
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

export function createPollyTTS(options?: PollyTTSOptions): PollyTTS {
  return new PollyTTS(options);
}
