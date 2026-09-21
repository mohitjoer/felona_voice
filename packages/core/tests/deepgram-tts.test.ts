import { describe, it, expect } from "vitest";
import { DeepgramTTS, createDeepgramTTS } from "../src/tts/deepgram.js";

describe("DeepgramTTS", () => {
  it("initializes with default model and custom apiKey", () => {
    const tts = createDeepgramTTS({ apiKey: "test-api-key" });
    expect(tts.name).toBe("deepgram");
  });

  it("handles custom model", () => {
    const tts = new DeepgramTTS({ apiKey: "test-api-key", model: "aura-orpheus-en" });
    expect(tts.name).toBe("deepgram");
  });
});
