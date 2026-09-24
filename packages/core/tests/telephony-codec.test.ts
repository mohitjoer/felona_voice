import { describe, it, expect } from "vitest";
import {
  mulawToPcm16,
  pcm16ToMulaw,
  resamplePcm16,
  mulaw8kToPcm16k,
  pcm16ToMulaw8k,
  linearSampleToMulaw,
} from "../src/telephony/codec.js";

describe("Telephony Audio Codec (G.711 μ-law)", () => {
  it("encodes zero linear sample to 0xff silence byte and decodes back to zero", () => {
    const encoded = linearSampleToMulaw(0);
    expect(encoded).toBe(0xff);

    const buf = Buffer.from([0xff]);
    const decoded = mulawToPcm16(buf);
    expect(decoded.length).toBe(2);
    expect(decoded.readInt16LE(0)).toBe(0);
  });

  it("encodes and decodes positive and negative linear PCM buffers with high fidelity", () => {
    // 4 sample test buffer: [0, 1000, -1000, 16000]
    const pcmIn = Buffer.alloc(8);
    pcmIn.writeInt16LE(0, 0);
    pcmIn.writeInt16LE(1000, 2);
    pcmIn.writeInt16LE(-1000, 4);
    pcmIn.writeInt16LE(16000, 6);

    const mulaw = pcm16ToMulaw(pcmIn);
    expect(mulaw.length).toBe(4);

    const pcmOut = mulawToPcm16(mulaw);
    expect(pcmOut.length).toBe(8);

    expect(pcmOut.readInt16LE(0)).toBe(0);
    // μ-law is a lossy compander; check close approximation within companding quantization error (<3%)
    expect(Math.abs(pcmOut.readInt16LE(2) - 1000)).toBeLessThan(50);
    expect(Math.abs(pcmOut.readInt16LE(4) - (-1000))).toBeLessThan(50);
    expect(Math.abs(pcmOut.readInt16LE(6) - 16000)).toBeLessThan(500);
  });

  it("handles maximum clipping range smoothly", () => {
    const pcmClip = Buffer.alloc(4);
    pcmClip.writeInt16LE(32767, 0);
    pcmClip.writeInt16LE(-32768, 2);

    const mulaw = pcm16ToMulaw(pcmClip);
    const pcmOut = mulawToPcm16(mulaw);

    // Max values decode to standard max G.711 levels
    expect(pcmOut.readInt16LE(0)).toBeGreaterThan(30000);
    expect(pcmOut.readInt16LE(2)).toBeLessThan(-30000);
  });
});

describe("Telephony Resampling", () => {
  it("upsamples 8,000 Hz to 16,000 Hz by 2x using linear interpolation", () => {
    const in8k = Buffer.alloc(4); // 2 samples: 1000, 3000
    in8k.writeInt16LE(1000, 0);
    in8k.writeInt16LE(3000, 2);

    const out16k = resamplePcm16(in8k, 8000, 16000);
    expect(out16k.length).toBe(8); // 4 samples

    expect(out16k.readInt16LE(0)).toBe(1000);
    expect(out16k.readInt16LE(2)).toBe(2000); // interpolated midpoint
    expect(out16k.readInt16LE(4)).toBe(3000);
  });

  it("downsamples 16,000 Hz to 8,000 Hz by 2x", () => {
    const in16k = Buffer.alloc(8); // 4 samples: 1000, 3000, 5000, 7000
    in16k.writeInt16LE(1000, 0);
    in16k.writeInt16LE(3000, 2);
    in16k.writeInt16LE(5000, 4);
    in16k.writeInt16LE(7000, 6);

    const out8k = resamplePcm16(in16k, 16000, 8000);
    expect(out8k.length).toBe(4); // 2 samples
    expect(out8k.readInt16LE(0)).toBe(2000); // avg(1000, 3000)
    expect(out8k.readInt16LE(2)).toBe(6000); // avg(5000, 7000)
  });

  it("downsamples 24,000 Hz to 8,000 Hz by 3x (e.g. ElevenLabs/Cartesia TTS)", () => {
    const in24k = Buffer.alloc(6); // 3 samples: 1000, 2000, 3000
    in24k.writeInt16LE(1000, 0);
    in24k.writeInt16LE(2000, 2);
    in24k.writeInt16LE(3000, 4);

    const out8k = resamplePcm16(in24k, 24000, 8000);
    expect(out8k.length).toBe(2); // 1 sample
    expect(out8k.readInt16LE(0)).toBe(2000); // avg(1000, 2000, 3000)
  });

  it("returns identical buffer when fromSampleRate equals toSampleRate", () => {
    const buf = Buffer.alloc(10);
    expect(resamplePcm16(buf, 16000, 16000)).toBe(buf);
  });

  it("converts mulaw8kToPcm16k and pcm16ToMulaw8k end-to-end", () => {
    const mulawIn = Buffer.from([0xff, 0x80, 0x7f, 0x00]);
    const pcm16k = mulaw8kToPcm16k(mulawIn);
    expect(pcm16k.length).toBe(mulawIn.length * 2 * 2); // 4 * 2 (16bit) * 2 (2x rate) = 16 bytes

    const mulawBack = pcm16ToMulaw8k(pcm16k, 16000);
    expect(mulawBack.length).toBe(mulawIn.length);
  });
});
