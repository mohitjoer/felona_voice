import { describe, it, expect } from "vitest";
import {
  ElevenLabsTTS,
  createElevenLabsTTS,
  DeepgramTTS,
  createDeepgramTTS,
  OpenAITTS,
  createOpenAITTS,
  CartesiaTTS,
  createCartesiaTTS,
  AzureTTS,
  createAzureTTS,
  PollyTTS,
  createPollyTTS,
  LMNTTTS,
  createLMNTTTS,
} from "../src/index.js";

describe("TTS Providers", () => {
  describe("ElevenLabsTTS", () => {
    it("initializes with default voice", () => {
      const tts = createElevenLabsTTS({ apiKey: "test-xi-key" });
      expect(tts.name).toBe("elevenlabs");
    });
  });

  describe("DeepgramTTS", () => {
    it("initializes with default model", () => {
      const tts = createDeepgramTTS({ apiKey: "test-dg-key" });
      expect(tts.name).toBe("deepgram");
    });
  });

  describe("OpenAITTS", () => {
    it("initializes with options", () => {
      const tts = createOpenAITTS({ apiKey: "test-openai-key", voice: "alloy" });
      expect(tts.name).toBe("openai");
    });
  });

  describe("CartesiaTTS", () => {
    it("initializes with options", () => {
      const tts = createCartesiaTTS({ apiKey: "test-cartesia-key", voice: "voice-123" });
      expect(tts.name).toBe("cartesia");
    });
  });

  describe("AzureTTS", () => {
    it("initializes with region and voice", () => {
      const tts = createAzureTTS({ apiKey: "test-azure-key", region: "eastus", voice: "en-US-JennyNeural" });
      expect(tts.name).toBe("azure");
    });
  });

  describe("PollyTTS", () => {
    it("initializes with AWS region and voice", () => {
      const tts = createPollyTTS({ apiKey: "test-polly-key", region: "us-east-1", voice: "Joanna" });
      expect(tts.name).toBe("polly");
    });
  });

  describe("LMNTTTS", () => {
    it("initializes with voice", () => {
      const tts = createLMNTTTS({ apiKey: "test-lmnt-key", voice: "lily" });
      expect(tts.name).toBe("lmnt");
    });
  });
});
