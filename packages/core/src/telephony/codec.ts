/**
 * G.711 mu-law (PCMU) Audio Codec & Resampler for Telephony (Twilio, Telnyx, etc.)
 *
 * Telephony mobile carriers and Twilio Media Streams stream audio encoded
 * as 8-bit mu-law (PCMU) at 8,000 Hz. This module provides zero-dependency,
 * microsecond-speed bi-directional transcoding between G.711 mu-law and 16-bit linear PCM,
 * as well as sample-rate conversion between 8kHz, 16kHz, 24kHz, and 48kHz.
 */

// ─── Precomputed G.711 μ-law ↔ A-law ↔ Linear PCM Tables ──────────────────

const MULAW_TO_LINEAR_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const uByte = ~i & 0xff;
  const sign = uByte & 0x80;
  const exponent = (uByte >> 4) & 0x07;
  const mantissa = uByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_TO_LINEAR_TABLE[i] = sign ? -sample : sample;
}

const ALAW_TO_LINEAR_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  // The alternate-bit inversion happens first, and the sign bit is read from
  // the *inverted* byte.
  const aByte = i ^ 0x55;
  const sign = aByte & 0x80;
  const exponent = (aByte >> 4) & 0x07;
  const mantissa = aByte & 0x0f;
  let sample = mantissa << 4;
  switch (exponent) {
    case 0:
      sample += 8;
      break;
    case 1:
      sample += 0x108;
      break;
    default:
      sample += 0x108;
      sample <<= exponent - 1;
      break;
  }
  ALAW_TO_LINEAR_TABLE[i] = sign ? sample : -sample;
}

// ─── Linear PCM to μ-law Constants ──────────────────────────────────────────

const BIAS = 0x84; // 132
const CLIP = 32635;

/** A-law: upper bound of each magnitude segment, searched after `pcm >> 3`. */
const ALAW_SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** A-law alternate-bit mask; XORed on encode and decode. */
const ALAW_AMI_MASK = 0x55;

/**
 * Encode a single 16-bit signed linear PCM sample (-32768..32767) to 8-bit μ-law byte.
 */
export function linearSampleToMulaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Encode a single 16-bit signed linear PCM sample (-32768..32767) to 8-bit A-law byte.
 *
 * Implements the ITU-T G.711 A-law mapping: reduce to 13 bits, locate the
 * magnitude segment, then emit a 3-bit segment, 4-bit mantissa and inverted
 * sign bit.
 */
export function linearSampleToAlaw(sample: number): number {
  // 16-bit -> 13-bit dynamic range
  let pcm = sample >> 3;
  let mask: number;

  if (pcm >= 0) {
    mask = ALAW_AMI_MASK | 0x80;
  } else {
    mask = ALAW_AMI_MASK;
    pcm = -pcm - 1;
  }

  // Smallest segment whose upper bound covers this magnitude.
  let seg = ALAW_SEG_AEND.length;
  for (let i = 0; i < ALAW_SEG_AEND.length; i++) {
    if (pcm <= ALAW_SEG_AEND[i]) {
      seg = i;
      break;
    }
  }

  if (seg >= ALAW_SEG_AEND.length) {
    // Saturate rather than wrap.
    return 0x7f ^ mask;
  }

  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return (aval ^ mask) & 0xff;
}

/**
 * Decode 8-bit G.711 μ-law bytes to 16-bit linear PCM (little-endian).
 */
export function mulawToPcm16(mulaw: Uint8Array | Buffer): Buffer {
  const len = mulaw.length;
  const out = Buffer.allocUnsafe(len * 2);
  for (let i = 0; i < len; i++) {
    const sample = MULAW_TO_LINEAR_TABLE[mulaw[i]];
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/**
 * Decode 8-bit G.711 A-law bytes to 16-bit linear PCM (little-endian).
 */
export function alawToPcm16(alaw: Uint8Array | Buffer): Buffer {
  const len = alaw.length;
  const out = Buffer.allocUnsafe(len * 2);
  for (let i = 0; i < len; i++) {
    const sample = ALAW_TO_LINEAR_TABLE[alaw[i]];
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/**
 * Encode 16-bit linear PCM (little-endian) to 8-bit G.711 μ-law bytes.
 */
export function pcm16ToMulaw(pcm16: Uint8Array | Buffer): Buffer {
  const samples = Math.floor(pcm16.length / 2);
  const out = Buffer.allocUnsafe(samples);
  const read = int16Reader(pcm16);

  for (let i = 0; i < samples; i++) {
    out[i] = linearSampleToMulaw(read(i));
  }
  return out;
}

/**
 * Encode 16-bit linear PCM (little-endian) to 8-bit G.711 A-law bytes.
 */
export function pcm16ToAlaw(pcm16: Uint8Array | Buffer): Buffer {
  const samples = Math.floor(pcm16.length / 2);
  const out = Buffer.allocUnsafe(samples);
  const read = int16Reader(pcm16);

  for (let i = 0; i < samples; i++) {
    out[i] = linearSampleToAlaw(read(i));
  }
  return out;
}

/**
 * Build a fast sample reader for a PCM buffer.
 *
 * The reader is created once per call: allocating a `DataView` per sample (as
 * the previous implementation did for non-Buffer input) dominated the cost of
 * the encode in this hot audio path.
 */
function int16Reader(pcm16: Uint8Array | Buffer): (index: number) => number {
  if (Buffer.isBuffer(pcm16)) {
    return (index) => pcm16.readInt16LE(index * 2);
  }
  const view = new DataView(
    pcm16.buffer,
    pcm16.byteOffset,
    pcm16.byteLength,
  );
  return (index) => view.getInt16(index * 2, true);
}

/**
 * Resample 16-bit linear PCM audio between two sample rates.
 * Optimized with dedicated fast paths for 8kHz <-> 16kHz and 24kHz -> 8kHz,
 * with linear interpolation for arbitrary rates.
 */
export function resamplePcm16(
  inputPcm16: Buffer,
  fromSampleRate: number,
  toSampleRate: number
): Buffer {
  if (fromSampleRate === toSampleRate || inputPcm16.length === 0) {
    return inputPcm16;
  }

  const inSamples = Math.floor(inputPcm16.length / 2);

  // Fast path: 8,000 Hz -> 16,000 Hz (2x upsample)
  if (fromSampleRate === 8000 && toSampleRate === 16000) {
    const out = Buffer.allocUnsafe(inSamples * 4);
    for (let i = 0; i < inSamples; i++) {
      const s1 = inputPcm16.readInt16LE(i * 2);
      const s2 = i + 1 < inSamples ? inputPcm16.readInt16LE((i + 1) * 2) : s1;
      out.writeInt16LE(s1, i * 4);
      out.writeInt16LE(Math.round((s1 + s2) / 2), i * 4 + 2);
    }
    return out;
  }

  // Fast path: 16,000 Hz -> 8,000 Hz (2x downsample)
  if (fromSampleRate === 16000 && toSampleRate === 8000) {
    const outSamples = Math.floor(inSamples / 2);
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const s1 = inputPcm16.readInt16LE(i * 4);
      const s2 = inputPcm16.readInt16LE(i * 4 + 2);
      out.writeInt16LE(Math.round((s1 + s2) / 2), i * 2);
    }
    return out;
  }

  // Fast path: 24,000 Hz -> 8,000 Hz (3x downsample, e.g. ElevenLabs/Cartesia)
  if (fromSampleRate === 24000 && toSampleRate === 8000) {
    const outSamples = Math.floor(inSamples / 3);
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const s1 = inputPcm16.readInt16LE(i * 6);
      const s2 = inputPcm16.readInt16LE(i * 6 + 2);
      const s3 = inputPcm16.readInt16LE(i * 6 + 4);
      out.writeInt16LE(Math.round((s1 + s2 + s3) / 3), i * 2);
    }
    return out;
  }

  // General arbitrary linear interpolation
  const ratio = fromSampleRate / toSampleRate;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.allocUnsafe(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s1 = inputPcm16.readInt16LE(idx * 2);
    const s2 = idx + 1 < inSamples ? inputPcm16.readInt16LE((idx + 1) * 2) : s1;
    const interpolated = Math.round(s1 + frac * (s2 - s1));
    const clamped = Math.max(-32768, Math.min(32767, interpolated));
    out.writeInt16LE(clamped, i * 2);
  }

  return out;
}

/**
 * Transcode incoming 8kHz μ-law audio (from Twilio) directly to 16kHz linear PCM.
 */
export function mulaw8kToPcm16k(mulaw: Buffer | Uint8Array): Buffer {
  const pcm8k = mulawToPcm16(mulaw);
  return resamplePcm16(pcm8k, 8000, 16000);
}

/**
 * Transcode incoming 8kHz A-law audio directly to 16kHz linear PCM.
 */
export function alaw8kToPcm16k(alaw: Buffer | Uint8Array): Buffer {
  const pcm8k = alawToPcm16(alaw);
  return resamplePcm16(pcm8k, 8000, 16000);
}

/**
 * Transcode outgoing linear PCM audio at any sample rate to 8kHz μ-law (for Twilio).
 */
export function pcm16ToMulaw8k(pcm16: Buffer, sampleRate: number): Buffer {
  const resampled = sampleRate === 8000 ? pcm16 : resamplePcm16(pcm16, sampleRate, 8000);
  return pcm16ToMulaw(resampled);
}

/**
 * Transcode outgoing linear PCM audio at any sample rate to 8kHz A-law.
 */
export function pcm16ToAlaw8k(pcm16: Buffer, sampleRate: number): Buffer {
  const resampled = sampleRate === 8000 ? pcm16 : resamplePcm16(pcm16, sampleRate, 8000);
  return pcm16ToAlaw(resampled);
}

/** G.711 encodings understood on the wire. */
export type G711Encoding = "mulaw" | "alaw";

/** Sample rate the pipeline works in internally. */
export const PIPELINE_SAMPLE_RATE = 16000;

/**
 * Decode an inbound telephony audio payload to 16kHz linear PCM.
 *
 * Driven by the stream's declared `mediaFormat` rather than assuming μ-law:
 * a PCMA stream decoded as μ-law is pure noise.
 */
export function decodeTelephonyAudio(
  payload: Buffer,
  encoding: G711Encoding,
  sampleRate: number,
): Buffer {
  const pcm = encoding === "alaw" ? alawToPcm16(payload) : mulawToPcm16(payload);
  return sampleRate === PIPELINE_SAMPLE_RATE
    ? pcm
    : resamplePcm16(pcm, sampleRate, PIPELINE_SAMPLE_RATE);
}

/**
 * Encode outbound linear PCM audio for a telephony stream.
 */
export function encodeTelephonyAudio(
  pcm16: Buffer,
  sampleRate: number,
  encoding: G711Encoding,
): Buffer {
  const resampled =
    sampleRate === 8000 ? pcm16 : resamplePcm16(pcm16, sampleRate, 8000);
  return encoding === "alaw" ? pcm16ToAlaw(resampled) : pcm16ToMulaw(resampled);
}
