import { streamPcm } from "./stream-pcm.js";
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

    yield* streamPcm(
      url.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify({ text }),
      },
      {
        sampleRate: 16000,
        providerLabel: "Deepgram TTS",
        signal: options?.signal,
      },
    );
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
