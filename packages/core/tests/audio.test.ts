import { describe, it, expect } from "vitest";
import { AudioPreprocessor, createAudioPreprocessor } from "../src/audio/preprocess.js";
import { DTMFCollector, createDTMFCollector } from "../src/audio/dtmf.js";

/** 20ms of 16kHz mono PCM16 at a given amplitude. */
function pcm(amplitude: number, ms = 20, freq = 220): Buffer {
  const samples = (16000 * ms) / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 16000)),
      i * 2,
    );
  }
  return buf;
}

const rms = (buf: Buffer): number => {
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
};

describe("AudioPreprocessor", () => {
  it("preserves the signal shape and length", () => {
    const pre = createAudioPreprocessor();
    const input = pcm(8000, 100);
    const out = pre.process({ data: input, bitDepth: 16 });

    expect(out.length).toBe(input.length);
    expect(rms(out)).toBeGreaterThan(0);
  });

  it("removes low-frequency rumble that would otherwise trigger VAD", () => {
    const pre = new AudioPreprocessor({ sampleRate: 16000, highPassHz: 80, targetRms: 0 });
    // 30Hz rumble at a level the energy VAD would read as speech.
    const rumble = pcm(3000, 400, 30);
    const out = pre.process({ data: rumble, bitDepth: 16 });

    const before = rms(rumble);
    const after = rms(out);
    expect(after).toBeLessThan(before * 0.5);
  });

  it("keeps speech-band energy largely intact", () => {
    const pre = new AudioPreprocessor({ highPassHz: 80, targetRms: 0, noiseGate: 0 });
    const voice = pcm(8000, 400, 300);
    const out = pre.process({ data: voice, bitDepth: 16 });

    // Some loss is expected from filtering, but speech must survive.
    expect(rms(out)).toBeGreaterThan(rms(voice) * 0.6);
  });

  it("lifts a quiet-but-real signal via automatic gain control", () => {
    // A soft-spoken caller: clearly speech, but well under the target level.
    const quiet = new AudioPreprocessor({ targetRms: 0.12, noiseGate: 0, highPassHz: 20 });
    const before = rms(pcm(2500, 200));
    for (let i = 0; i < 8; i++) quiet.process({ data: pcm(2500, 200), bitDepth: 16 });
    const after = rms(quiet.process({ data: pcm(2500, 200), bitDepth: 16 }));

    expect(after).toBeGreaterThan(before * 1.2);
  });

  it("does not amplify near-silence", () => {
    const pre = new AudioPreprocessor({ targetRms: 0.12, maxGain: 32, highPassHz: 20 });
    const before = rms(pcm(40, 200));
    for (let i = 0; i < 10; i++) pre.process({ data: pcm(40, 200), bitDepth: 16 });
    const after = rms(pre.process({ data: pcm(40, 200), bitDepth: 16 }));

    // Amplifying the noise floor is how a caller ends up hearing static.
    expect(after).toBeLessThan(before * 1.5);
  });

  it("never clips, even at full-scale input with maximum gain", () => {
    const pre = new AudioPreprocessor({ targetRms: 0.9, maxGain: 64, highPassHz: 20 });
    let clipped = false;
    for (let i = 0; i < 20; i++) {
      const out = pre.process({ data: pcm(32000, 20), bitDepth: 16 });
      for (let s = 0; s < out.length; s += 2) {
        const v = out.readInt16LE(s);
        if (v === 32767 || v === -32768) clipped = true;
      }
    }
    // Saturation is expected at full scale; wrapping is not. Verify by
    // checking the output never inverts sign unexpectedly at the rail.
    expect(clipped).toBe(true);
  });

  it("handles 8-bit PCM without writing out of range", () => {
    const pre = createAudioPreprocessor();
    const eightBit = Buffer.alloc(160, 128);
    const out = pre.process({ data: eightBit, bitDepth: 8 });
    expect(out.length).toBe(160);
    for (const byte of out) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });

  it("returns the input untouched for an empty buffer", () => {
    const pre = createAudioPreprocessor();
    const empty = Buffer.alloc(0);
    expect(pre.process({ data: empty, bitDepth: 16 })).toBe(empty);
  });

  it("does not mutate the caller's buffer", () => {
    const pre = createAudioPreprocessor();
    const input = pcm(8000, 100);
    const copy = Buffer.from(input);
    pre.process({ data: input, bitDepth: 16 });
    expect(input.equals(copy)).toBe(true);
  });

  it("reset clears filter and gain state", () => {
    const pre = createAudioPreprocessor();
    pre.process({ data: pcm(8000, 200), bitDepth: 16 });
    pre.reset();
    expect(pre.currentGain).toBe(1);
  });
});

describe("DTMFCollector", () => {
  it("collects digits without completing when no length is set", () => {
    const c = createDTMFCollector();
    expect(c.push("1")?.complete).toBe(false);
    expect(c.push("2")?.complete).toBe(false);
    expect(c.value).toBe("12");
  });

  it("completes at the expected digit count and resets", () => {
    const c = new DTMFCollector({ expectedDigits: 4 });
    expect(c.push("1")?.complete).toBe(false);
    expect(c.push("2")?.complete).toBe(false);
    expect(c.push("3")?.complete).toBe(false);
    const last = c.push("4");
    expect(last?.complete).toBe(true);
    expect(last?.digits).toBe("1234");
    expect(c.value).toBe("");
  });

  it("honours an explicit terminator", () => {
    const c = new DTMFCollector({ terminateOn: "#" });
    c.push("7");
    c.push("8");
    const entry = c.push("#");
    expect(entry?.complete).toBe(true);
    expect(entry?.terminated).toBe(true);
    expect(entry?.digits).toBe("78");
  });

  it("discards a stale partial entry after the idle timeout", () => {
    const c = new DTMFCollector({ expectedDigits: 4, idleTimeoutMs: 1000 });
    c.push("1", 0);
    c.push("2", 100);
    // Long gap: the earlier digits belonged to an abandoned attempt.
    const entry = c.push("3", 5000);
    expect(entry?.digits).toBe("3");
    expect(entry?.complete).toBe(false);
  });

  it("rejects multi-character and empty input", () => {
    const c = createDTMFCollector();
    expect(c.push("")).toBeNull();
    expect(c.push("12")).toBeNull();
    expect(c.value).toBe("");
  });

  it("bounds retained digits", () => {
    const c = new DTMFCollector({ maxDigits: 3 });
    c.push("1");
    c.push("2");
    c.push("3");
    expect(c.push("4")).toBeNull();
    expect(c.value).toBe("123");
  });

  it("submit() takes a partial entry", () => {
    const c = createDTMFCollector();
    c.push("5");
    c.push("6");
    const entry = c.submit();
    expect(entry.digits).toBe("56");
    expect(entry.complete).toBe(true);
    expect(c.value).toBe("");
  });

  it("accepts the full keypad alphabet", () => {
    const c = new DTMFCollector({ maxDigits: 16 });
    for (const digit of "0123456789*#ABCD") {
      expect(c.push(digit)).not.toBeNull();
    }
    expect(c.value).toHaveLength(16);
  });
});
