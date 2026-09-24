/**
 * G.711 mu-law (PCMU) Audio Codec & Resampler for Telephony (Twilio, Telnyx, etc.)
 *
 * Telephony mobile carriers and Twilio Media Streams stream audio encoded
 * as 8-bit mu-law (PCMU) at 8,000 Hz. This module provides zero-dependency,
 * microsecond-speed bi-directional transcoding between G.711 mu-law and 16-bit linear PCM,
 * as well as sample-rate conversion between 8kHz, 16kHz, 24kHz, and 48kHz.
 */

// ─── Precomputed G.711 μ-law to Linear PCM Table ───────────────────────────

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

// ─── Linear PCM to μ-law Constants ──────────────────────────────────────────

const BIAS = 0x84; // 132
const CLIP = 32635;

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
 * Encode 16-bit linear PCM (little-endian) to 8-bit G.711 μ-law bytes.
 */
export function pcm16ToMulaw(pcm16: Uint8Array | Buffer): Buffer {
  const samples = Math.floor(pcm16.length / 2);
  const out = Buffer.allocUnsafe(samples);
  const isBuffer = Buffer.isBuffer(pcm16);

  for (let i = 0; i < samples; i++) {
    const sample = isBuffer
      ? pcm16.readInt16LE(i * 2)
      : new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).getInt16(i * 2, true);
    out[i] = linearSampleToMulaw(sample);
  }
  return out;
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
 * Transcode outgoing linear PCM audio at any sample rate to 8kHz μ-law (for Twilio).
 */
export function pcm16ToMulaw8k(pcm16: Buffer, sampleRate: number): Buffer {
  const resampled = sampleRate === 8000 ? pcm16 : resamplePcm16(pcm16, sampleRate, 8000);
  return pcm16ToMulaw(resampled);
}
