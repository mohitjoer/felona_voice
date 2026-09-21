import type { TTSProvider, TTSOptions, AudioChunk } from "../types.js";

export interface AzureTTSOptions {
  apiKey: string;
  region: string;
  voice?: string;
  language?: string;
}

/**
 * AzureTTS — Streaming Neural Text-to-Speech using Microsoft Azure Cognitive Services.
 */
export class AzureTTS implements TTSProvider {
  readonly name = "azure";
  private readonly apiKey: string;
  private readonly region: string;
  private readonly defaultVoice: string;
  private readonly language: string;

  constructor(options: AzureTTSOptions) {
    this.apiKey = options.apiKey;
    this.region = options.region;
    this.defaultVoice = options.voice ?? "en-US-JennyNeural";
    this.language = options.language ?? "en-US";
  }

  async *synthesize(
    text: string,
    options?: TTSOptions
  ): AsyncIterable<AudioChunk> {
    const voice = options?.voice ?? this.defaultVoice;
    const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const cleanText = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const rate = options?.speed ? `${Math.round((options.speed - 1) * 100)}%` : "0%";
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${this.language}'>
      <voice name='${voice}'>
        <prosody rate='${rate}'>${cleanText}</prosody>
      </voice>
    </speak>`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.apiKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-16khz-16bit-mono-pcm",
        "User-Agent": "FelonaVoiceAgent",
      },
      body: ssml,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure TTS failed: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("Azure TTS returned no response body");
    }

    const reader = response.body.getReader();
    let timestampMs = 0;
    const sampleRate = 16000;
    const bytesPerSecond = sampleRate * 2; // 16kHz * 16-bit = 32000 bytes/sec

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk: AudioChunk = {
          data: Buffer.from(value),
          sampleRate,
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

export function createAzureTTS(options: AzureTTSOptions): AzureTTS {
  return new AzureTTS(options);
}
