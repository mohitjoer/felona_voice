import { streamPcm } from "./stream-pcm.js";
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

    // Everything interpolated into the SSML document is config- or
    // caller-supplied, so it is escaped at the boundary. Unescaped, a voice
    // name containing a quote breaks out of the attribute and can inject
    // arbitrary SSML.
    const cleanText = escapeXml(text);
    const cleanVoice = escapeXml(voice);
    const cleanLanguage = escapeXml(this.language);

    const rate = options?.speed ? `${Math.round((options.speed - 1) * 100)}%` : "0%";
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${cleanLanguage}'>
      <voice name='${cleanVoice}'>
        <prosody rate='${rate}'>${cleanText}</prosody>
      </voice>
    </speak>`;

    yield* streamPcm(
      url,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.apiKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-16khz-16bit-mono-pcm",
          "User-Agent": "FelonaVoiceAgent",
        },
        body: ssml,
      },
      {
        // The OutputFormat header above is fixed at 16kHz; the timestamp
        // arithmetic must match it or playback drifts.
        sampleRate: 16000,
        providerLabel: "Azure TTS",
        signal: options?.signal,
      },
    );
  }
}

/** Escapes text for safe interpolation into an SSML/XML attribute or body. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

export function createAzureTTS(options: AzureTTSOptions): AzureTTS {
  return new AzureTTS(options);
}
