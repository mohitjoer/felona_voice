import { describe, it, expect } from "vitest";
import {
  DeepgramSTT,
  createDeepgramSTT,
  WhisperSTT,
  createWhisperSTT,
  AssemblyAISTT,
  createAssemblyAISTT,
  AzureSTT,
  createAzureSTT,
  GoogleSTT,
  createGoogleSTT,
  pcmToWav,
} from "../src/index.js";

describe("STT Providers & Audio Utils", () => {
  describe("pcmToWav", () => {
    it("generates a valid 44-byte WAV header for linear PCM", () => {
      const pcm = Buffer.alloc(3200); // 0.1s of 16kHz 16-bit mono PCM
      const wav = pcmToWav(pcm, 16000, 1, 16);

      expect(wav.length).toBe(44 + 3200);
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
      expect(wav.readUInt32LE(24)).toBe(16000); // sampleRate
      expect(wav.readUInt16LE(22)).toBe(1); // channels
      expect(wav.readUInt16LE(34)).toBe(16); // bitDepth
      expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
      expect(wav.readUInt32LE(40)).toBe(3200); // data chunk size
    });
  });

  describe("DeepgramSTT", () => {
    it("initializes and creates a stream", () => {
      const stt = createDeepgramSTT({ apiKey: "test-dg-key" });
      expect(stt.name).toBe("deepgram");
      const stream = stt.createStream({ language: "en-US" });
      expect(typeof stream.write).toBe("function");
      expect(typeof stream.onResult).toBe("function");
      expect(typeof stream.close).toBe("function");
    });
  });

  describe("WhisperSTT", () => {
    it("initializes with default model and creates stream", () => {
      const stt = createWhisperSTT({ apiKey: "test-openai-key" });
      expect(stt.name).toBe("whisper");
      const stream = stt.createStream({ language: "en" });
      expect(typeof stream.write).toBe("function");
      expect(typeof stream.close).toBe("function");
    });

    it("buffers audio chunks without throwing", async () => {
      const stt = new WhisperSTT({ apiKey: "test-key", model: "whisper-1" });
      const stream = stt.createStream();
      stream.write({
        data: Buffer.alloc(100),
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        timestampMs: 0,
      });
      // Small buffer close skips API call safely
      await stream.close();
    });
  });

  describe("AssemblyAISTT", () => {
    it("initializes and creates a stream", () => {
      const stt = createAssemblyAISTT({ apiKey: "test-assembly-key" });
      expect(stt.name).toBe("assemblyai");
      const stream = stt.createStream({ keywords: ["billing", "refund"] });
      expect(typeof stream.write).toBe("function");
      expect(typeof stream.close).toBe("function");
    });
  });

  describe("AzureSTT", () => {
    it("initializes with region and language", () => {
      const stt = createAzureSTT({ apiKey: "test-azure-key", region: "eastus" });
      expect(stt.name).toBe("azure");
      const stream = stt.createStream({ language: "en-US" });
      expect(typeof stream.write).toBe("function");
      expect(typeof stream.close).toBe("function");
    });
  });

  describe("GoogleSTT", () => {
    it("initializes with options", () => {
      const stt = createGoogleSTT({ apiKey: "test-google-key", languageCode: "en-US" });
      expect(stt.name).toBe("google");
      const stream = stt.createStream();
      expect(typeof stream.write).toBe("function");
      expect(typeof stream.close).toBe("function");
    });
  });
});
