import { streamPcm } from "./stream-pcm.js";
import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

export type OpenAIVoice =
  | "alloy"
  | "echo"
  | "fable"
  | "onyx"
  | "nova"
  | "shimmer"
  | string;

export interface OpenAITTSOptions {
  apiKey: string;
  voice?: OpenAIVoice;
  model?: "tts-1" | "tts-1-hd" | string;
  baseUrl?: string;
  speed?: number;
}

/**
 * OpenAITTS — Text-to-Speech using OpenAI's Audio Speech API.
 *
 * Streams raw linear 24kHz PCM audio chunks with sub-400ms TTFB.
 */
export class OpenAITTS implements TTSProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly defaultSpeed: number;

  constructor(options: OpenAITTSOptions) {
    this.apiKey = options.apiKey;
    this.defaultVoice = options.voice ?? "nova";
    this.model = options.model ?? "tts-1";
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.defaultSpeed = options.speed ?? 1.0;
  }

  async *synthesize(
    text: string,
    options?: TTSOptions
  ): AsyncIterable<AudioChunk> {
    const voice = options?.voice ?? this.defaultVoice;
    const speed = options?.speed ?? this.defaultSpeed;

    yield* streamPcm(
      `${this.baseUrl}/audio/speech`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice,
          response_format: "pcm", // Raw 24kHz 16-bit mono PCM
          speed,
        }),
      },
      {
        sampleRate: 24000,
        providerLabel: "OpenAI TTS",
        signal: options?.signal,
      },
    );
  }
}

export function createOpenAITTS(options: OpenAITTSOptions): OpenAITTS {
  return new OpenAITTS(options);
}
