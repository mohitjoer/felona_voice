import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

/**
 * DeepgramTTS — Streaming and batch Text-to-Speech using Deepgram Aura API.
 */
export class DeepgramTTS implements TTSProvider {
  readonly name = "deepgram";
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.model ?? "aura-asteria-en";
    this.baseUrl = options.baseUrl ?? "https://api.deepgram.com/v1";
  }

  async *synthesize(
    text: string,
    options?: TTSOptions,
  ): AsyncIterable<AudioChunk> {
    const model = options?.voice ?? this.defaultModel;
    const url = new URL(`${this.baseUrl}/speak`);
    url.searchParams.set("model", model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deepgram TTS failed: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("Deepgram TTS returned no response body");
    }

    const reader = response.body.getReader();
    let timestampMs = 0;
    const bytesPerSecond = 16000 * 2; // 16kHz, 16-bit mono = 32,000 bytes/sec

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk: AudioChunk = {
          data: Buffer.from(value),
          sampleRate: 16000,
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

/**
 * Factory function for creating DeepgramTTS instance.
 */
export function createDeepgramTTS(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): DeepgramTTS {
  return new DeepgramTTS(options);
}
