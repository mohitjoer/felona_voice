import { describe, it, expect } from "vitest";
import { EnergyVAD } from "../src/vad/energy.js";
import type { AudioChunk } from "../src/types.js";

function createSilentChunk(timestampMs: number): AudioChunk {
  // Silent audio — all zeros
  const data = Buffer.alloc(640); // 20ms at 16kHz, 16-bit
  return {
    data,
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    timestampMs,
  };
}

function createLoudChunk(timestampMs: number, amplitude = 8000): AudioChunk {
  // Loud audio — sine wave
  const samples = 320; // 20ms at 16kHz
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000));
    data.writeInt16LE(value, i * 2);
  }
  return {
    data,
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    timestampMs,
  };
}

describe("EnergyVAD", () => {
  it("detects speech start", () => {
    const vad = new EnergyVAD();

    // Feed silent audio
    const silentResult = vad.process(createSilentChunk(0));
    expect(silentResult.isSpeech).toBe(false);

    // Feed loud audio
    const loudResult = vad.process(createLoudChunk(20));
    expect(loudResult.isSpeech).toBe(true);
    expect(loudResult.event?.type).toBe("speech_start");
  });

  it("detects speech end after hangover period", () => {
    const vad = new EnergyVAD({ hangoverMs: 100, minSpeechMs: 10 });

    // Start speech
    vad.process(createLoudChunk(0));

    // Continue speech
    vad.process(createLoudChunk(20));

    // Silence begins — feed enough silent chunks to exceed hangover
    const results = [];
    for (let t = 40; t <= 300; t += 20) {
      results.push(vad.process(createSilentChunk(t)));
    }

    // At least one chunk should have triggered speech_end
    const speechEndEvent = results.find((r) => r.event?.type === "speech_end");
    expect(speechEndEvent).toBeDefined();
    expect(speechEndEvent!.isSpeech).toBe(false);
  });

  it("does not emit speech_end during hangover", () => {
    const vad = new EnergyVAD({ hangoverMs: 500 });

    // Start speech
    vad.process(createLoudChunk(0));

    // Brief silence (within hangover)
    const result = vad.process(createSilentChunk(100));
    expect(result.isSpeech).toBe(true); // Still within hangover
    expect(result.event).toBeUndefined();
  });

  it("resets internal state", () => {
    const vad = new EnergyVAD();

    // Start speech
    vad.process(createLoudChunk(0));

    // Reset
    vad.reset();

    // After reset, should start fresh
    const result = vad.process(createSilentChunk(0));
    expect(result.isSpeech).toBe(false);
  });
});
