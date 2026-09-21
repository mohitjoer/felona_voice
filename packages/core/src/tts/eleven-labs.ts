import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

/**
 * ElevenLabsTTS — Streaming Text-to-Speech using ElevenLabs' API.
 *
 * Uses the streaming endpoint for chunk-by-chunk audio delivery,
 * so the agent can start speaking before the full response is generated.
 */
export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly baseUrl: string;
  private readonly modelId: string;

  constructor(options: {
    apiKey: string;
    voice?: string;
    modelId?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.defaultVoice = options.voice ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel
    this.modelId = options.modelId ?? "eleven_turbo_v2_5";
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io/v1";
  }

  async *synthesize(
    text: string,
    options?: TTSOptions,
  ): AsyncIterable<AudioChunk> {
    const voiceId = options?.voice ?? this.defaultVoice;

    const response = await fetch(
      `${this.baseUrl}/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: options?.speed ?? 1.0,
          },
          output_format: "pcm_16000",
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `ElevenLabs TTS failed: ${response.status} ${error}`,
      );
    }

    if (!response.body) {
      throw new Error("ElevenLabs TTS returned no body");
    }

    const reader = response.body.getReader();
    let timestampMs = 0;
    const bytesPerSecond = 16000 * 2; // 16kHz * 16-bit = 32000 bytes/sec

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

        // Calculate timestamp based on audio duration
        timestampMs += (value.length / bytesPerSecond) * 1000;

        yield chunk;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function createElevenLabsTTS(options: {
  apiKey: string;
  voice?: string;
  modelId?: string;
}): ElevenLabsTTS {
  return new ElevenLabsTTS(options);
}
