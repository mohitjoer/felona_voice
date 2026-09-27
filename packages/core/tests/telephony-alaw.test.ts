import { describe, it, expect } from "vitest";
import {
  linearSampleToAlaw,
  alawToPcm16,
  pcm16ToAlaw,
  decodeTelephonyAudio,
  encodeTelephonyAudio,
  pcm16ToMulaw,
  mulawToPcm16,
  resamplePcm16,
  PIPELINE_SAMPLE_RATE,
} from "../src/telephony/codec.js";

/** Deterministic pseudo-audio: a triangle wave, so no clipping at the peaks. */
function makePcm(frames: number, amplitude = 8000): Buffer {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const phase = (i % 200) / 200;
    const value = Math.round(amplitude * (phase < 0.5 ? phase * 2 : (1 - phase) * 2));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

describe("G.711 A-law codec", () => {
  it("round-trips audio within A-law quantization error", () => {
    const pcm = makePcm(400);
    const decoded = alawToPcm16(pcm16ToAlaw(pcm));

    expect(decoded.length).toBe(pcm.length);

    let maxError = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      maxError = Math.max(maxError, Math.abs(decoded.readInt16LE(i) - pcm.readInt16LE(i)));
    }
    // A-law is ~12 bits of resolution; anything under ~512 is a clean round trip.
    expect(maxError).toBeLessThan(512);
  });

  it("preserves sign", () => {
    expect(linearSampleToAlaw(-1000)).not.toBe(linearSampleToAlaw(1000));
    expect(linearSampleToAlaw(0)).toBe(linearSampleToAlaw(-0));
  });

  it("handles the full-scale extremes without wrapping", () => {
    for (const sample of [-32768, -32767, -1, 1, 32766, 32767]) {
      const back = alawToPcm16(Buffer.from([linearSampleToAlaw(sample)]));
      const value = back.readInt16LE(0);
      expect(Math.sign(value), `sign of ${sample}`).toBe(Math.sign(sample));
      expect(Math.abs(value - sample)).toBeLessThan(1024);
    }

    // Zero is not exactly representable: A-law's smallest non-zero magnitude
    // step is 8, so silence must land within one step rather than on zero.
    expect(Math.abs(alawToPcm16(Buffer.from([linearSampleToAlaw(0)])).readInt16LE(0)))
      .toBeLessThanOrEqual(8);
  });

  it("clamps rather than overflowing on out-of-range input", () => {
    const huge = Buffer.alloc(2);
    huge.writeInt16LE(32767, 0);
    expect(() => pcm16ToAlaw(huge)).not.toThrow();
  });
});

describe("decodeTelephonyAudio / encodeTelephonyAudio", () => {
  it("decodes an 8kHz mu-law stream to 16kHz pipeline PCM", () => {
    const frames = 160; // 20ms at 8kHz
    const pcm8k = makePcm(frames);
    const mulaw = pcm16ToMulaw(pcm8k);

    const out = decodeTelephonyAudio(mulaw, "mulaw", 8000);

    expect(out.length).toBe(frames * 2 * 2); // doubled by 8k -> 16k
  });

  it("decodes an 8kHz A-law stream to 16kHz pipeline PCM", () => {
    const frames = 160;
    const alaw = pcm16ToAlaw(makePcm(frames));

    const out = decodeTelephonyAudio(alaw, "alaw", 8000);

    expect(out.length).toBe(frames * 2 * 2);
  });

  it("produces different bytes for the two encodings of the same audio", () => {
    // Guards against the original bug: ignoring mediaFormat and always
    // decoding as mu-law turns a PCMA stream into noise.
    const pcm = makePcm(160);
    const asMulaw = pcm16ToMulaw(pcm);
    const asAlaw = pcm16ToAlaw(pcm);

    expect(asMulaw.equals(asAlaw)).toBe(false);
    expect(decodeTelephonyAudio(asAlaw, "alaw", 8000).equals(
      decodeTelephonyAudio(asMulaw, "mulaw", 8000),
    )).toBe(false);
  });

  it("is a no-op resample when the stream is already at pipeline rate", () => {
    const pcm = makePcm(320);
    const mulaw = pcm16ToMulaw(pcm);
    const out = decodeTelephonyAudio(mulaw, "mulaw", PIPELINE_SAMPLE_RATE);
    expect(out).toEqual(mulawToPcm16(mulaw));
  });

  it("encodes outbound audio to 8kHz in the stream's encoding", () => {
    const pcm = makePcm(320, 4000);

    const mulawPayload = encodeTelephonyAudio(pcm, 16000, "mulaw");
    const alawPayload = encodeTelephonyAudio(pcm, 16000, "alaw");

    // 320 frames at 16kHz -> 160 frames at 8kHz, one byte per frame.
    expect(mulawPayload.length).toBe(160);
    expect(alawPayload.length).toBe(160);
    expect(mulawPayload.equals(alawPayload)).toBe(false);
  });
});

describe("resamplePcm16", () => {
  it("preserves signal energy through a 16k -> 8k downsample", () => {
    const input = makePcm(3200);
    const output = resamplePcm16(input, 16000, 8000);
    expect(output.length).toBe(1600 * 2);
  });

  it("returns the input untouched when rates match", () => {
    const input = makePcm(64);
    expect(resamplePcm16(input, 16000, 16000)).toBe(input);
  });
});
