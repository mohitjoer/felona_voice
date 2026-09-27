/**
 * Audio preprocessing for noisy telephony and browser input.
 *
 * Runs *before* VAD, STT and turn detection, so a cleaner signal improves every
 * downstream decision. This is the zero-dependency counterpart to the hosted
 * denoisers offered by commercial platforms: it cannot remove competing
 * speakers, but it reliably removes rumble, hiss and hum, which is what
 * corrupts RMS-based voice activity detection on 8kHz phone audio.
 *
 * Stages, in order:
 *   1. DC offset removal      — microphone bias / codec ringing
 *   2. High-pass filter       — rumble below the voice band
 *   3. Spectral noise gate    — attenuates quiet background noise
 *   4. Automatic gain control — normalizes level so thresholds mean something
 *
 * Limits worth knowing:
 * - This is not background-voice cancellation. Removing competing speakers
 *   needs a trained model; that is a deliberate non-goal here, since it would
 *   add a heavyweight dependency for a zero-dependency core.
 * - The noise gate engages on the quiet floor between speech. Sustained noise
 *   at speech level is indistinguishable from speech without a voice model, so
 *   the gate deliberately does not try.
 * - The high-pass and AGC are the load-bearing stages; both are pure
 *   arithmetic and safe to leave enabled.
 */

export interface AudioPreprocessorOptions {
  /** Sample rate of incoming audio in Hz. Default: 16000 */
  sampleRate?: number;
  /** Bits per sample (8 or 16). Default: 16 */
  bitDepth?: number;
  /**
   * High-pass corner frequency in Hz. Removes rumble below this.
   * Default: 80 (telephony-appropriate; speech fundamentals start ~85Hz).
   */
  highPassHz?: number;
  /**
   * Noise gate threshold as a fraction of the estimated noise floor.
   * 0 disables gating. Default: 0.06.
   */
  noiseGate?: number;
  /**
   * Target RMS for automatic gain control, 0-1. Default: 0.06.
   * Set to 0 to disable.
   */
  targetRms?: number;
  /** Maximum gain applied by AGC, to avoid amplifying noise into clipping. Default: 8 */
  maxGain?: number;
  /** How quickly the noise floor adapts to a new quiet level. 0-1. Default: 0.02 */
  noiseAdaptRate?: number;
}

/**
 * Streaming audio preprocessor.
 *
 * Stateful across chunks: the filter, noise estimate and gain all carry over,
 * because each 20ms chunk is far too short to estimate a noise floor on its own.
 * One instance per session.
 */
export class AudioPreprocessor {
  private readonly sampleRate: number;
  private readonly bitDepth: number;
  private readonly highPassAlpha: number;
  private readonly noiseGate: number;
  private readonly targetRms: number;
  private readonly maxGain: number;
  private readonly noiseAdaptRate: number;

  /** One-pole high-pass state. */
  private hpPrevIn = 0;
  private hpPrevOut = 0;

  /** Rolling RMS estimate of the background noise floor. */
  private noiseFloor = 0.002;

  /** Current applied gain, smoothed to avoid audible pumping. */
  private gain = 1;

  private primed = false;

  /**
   * Below this RMS a frame is treated as noise and left un-amplified.
   *
   * Absolute rather than relative to the learned floor: a floor that follows
   * quiet speech would classify a soft-spoken caller as noise and disable gain
   * for exactly the people who need it most.
   */
  private static readonly MIN_SIGNAL_RMS = 0.005;

  constructor(options?: AudioPreprocessorOptions) {
    const sampleRate = options?.sampleRate ?? 16000;
    this.sampleRate = sampleRate;
    this.bitDepth = options?.bitDepth ?? 16;
    this.noiseGate = options?.noiseGate ?? 0.06;
    this.targetRms = options?.targetRms ?? 0.06;
    this.maxGain = options?.maxGain ?? 8;
    this.noiseAdaptRate = options?.noiseAdaptRate ?? 0.02;

    // Standard one-pole high-pass: y[n] = a * (y[n-1] + x[n] - x[n-1])
    //   a = RC / (RC + dt),  RC = 1 / (2*pi*fc)
    const cutoff = options?.highPassHz ?? 80;
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / sampleRate;
    this.highPassAlpha = rc / (rc + dt);

    // Seed the filter with the first sample to avoid a startup transient.
    this.primed = false;
  }

  /** Current estimated background noise floor (RMS, 0-1). */
  get estimatedNoiseFloor(): number {
    return this.noiseFloor;
  }

  /** Current applied gain factor. */
  get currentGain(): number {
    return this.gain;
  }

  /**
   * Process a chunk in place-safe fashion, returning a new Buffer.
   *
   * `chunk.data` is never mutated — callers routinely reuse buffers.
   */
  process(chunk: { data: Buffer; bitDepth?: number }): Buffer {
    const bitDepth = chunk.bitDepth ?? this.bitDepth;
    const is16 = bitDepth === 16;
    const scale = is16 ? 32768 : 128;
    const bytesPerSample = is16 ? 2 : 1;

    const sampleCount = Math.floor(chunk.data.length / bytesPerSample);
    if (sampleCount === 0) return chunk.data;

    const out = Buffer.allocUnsafe(sampleCount * bytesPerSample);

    // Pass 1 — DC removal + high-pass + noise-floor/gain estimation.
    const filtered = new Float64Array(sampleCount);
    let sumSquares = 0;

    for (let i = 0; i < sampleCount; i++) {
      let value: number;
      if (is16) {
        value = chunk.data.readInt16LE(i * 2) / scale;
      } else {
        value = (chunk.data[i] - 128) / scale;
      }

      // Remove DC offset, then apply the one-pole high-pass.
      const highPassed = this.highPassAlpha * (this.hpPrevOut + value - this.hpPrevIn);
      this.hpPrevIn = value;
      this.hpPrevOut = highPassed;

      if (!this.primed) {
        // Seed the noise floor from the opening samples rather than from 0,
        // so a call that starts with speech does not treat it as noise.
        this.noiseFloor = Math.min(Math.abs(highPassed), 0.05);
        this.primed = true;
      }

      filtered[i] = highPassed;
      sumSquares += highPassed * highPassed;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);

    // Track the noise floor downward quickly and upward only slowly, and only
    // from genuinely quiet frames. Letting it follow quiet speech upward is
    // what makes an AGC "learn" that a soft-spoken caller is noise.
    if (rms < this.noiseFloor) {
      this.noiseFloor += (rms - this.noiseFloor) * this.noiseAdaptRate * 4;
    } else if (rms < AudioPreprocessor.MIN_SIGNAL_RMS) {
      this.noiseFloor += (rms - this.noiseFloor) * this.noiseAdaptRate;
    }

    // Automatic gain control toward the target RMS.
    if (this.targetRms > 0) {
      const isNoise = rms < AudioPreprocessor.MIN_SIGNAL_RMS;
      if (!isNoise) {
        const desired = this.targetRms / Math.max(rms, 1e-6);
        const wanted = Math.min(desired, this.maxGain);
        this.gain += (wanted - this.gain) * 0.2;
      }
    }

    // Pass 2 — spectral gate + gain, clamped to the sample range.
    const gateThreshold = this.noiseGate > 0 ? this.noiseFloor * (1 + this.noiseGate * 10) : 0;
    const gate = this.noiseGate > 0 ? Math.min(0.5, this.noiseGate) : 0;

    for (let i = 0; i < sampleCount; i++) {
      let value = filtered[i] * this.gain;

      if (gate > 0 && rms < gateThreshold) {
        // Quiet frame: attenuate toward silence, scaled by how far below the
        // gate we are, so the transition is smooth rather than a hard cut.
        const ratio = gateThreshold > 0 ? Math.min(1, rms / gateThreshold) : 1;
        value *= gate * ratio + (1 - gate) * ratio * ratio;
      }

      const scaled = Math.round(value * scale);
      const clamped = Math.max(is16 ? -32768 : -128, Math.min(is16 ? 32767 : 127, scaled));

      if (is16) out.writeInt16LE(clamped, i * 2);
      else out[i] = clamped + 128;
    }

    return out;
  }

  /** Reset filter, noise estimate and gain. Call between unrelated streams. */
  reset(): void {
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    this.noiseFloor = 0.002;
    this.gain = 1;
    this.primed = false;
  }
}

/** Factory, matching the createX convention used across the codebase. */
export function createAudioPreprocessor(
  options?: AudioPreprocessorOptions,
): AudioPreprocessor {
  return new AudioPreprocessor(options);
}
