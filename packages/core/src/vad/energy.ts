import type { VADProvider, VADResult, VADEvent, AudioChunk } from "../types.js";

/**
 * EnergyVAD — Simple energy-based Voice Activity Detection.
 *
 * This is a lightweight, zero-dependency VAD that detects speech
 * based on audio energy levels (RMS). It works well for most use cases
 * and requires no model loading.
 *
 * For Phase 1, this replaces the Silero VAD (which needs ONNX) to
 * avoid the heavy dependency. Silero VAD will be added in Phase 2
 * as an optional higher-accuracy alternative.
 *
 * Algorithm:
 * 1. Compute RMS energy of each audio chunk
 * 2. Compare against adaptive threshold
 * 3. Use hangover timer to prevent false speech-end events
 */
export class EnergyVAD implements VADProvider {
  readonly name = "energy";

  private readonly speechThreshold: number;
  private readonly silenceThreshold: number;
  private readonly hangoverMs: number;
  private readonly minSpeechMs: number;

  private isSpeaking = false;
  private speechStartMs = 0;
  private lastSpeechMs = 0;
  private energyHistory: number[] = [];
  private readonly historySize = 30;

  constructor(options?: {
    /** RMS threshold to start detecting speech (0-1). Default: 0.01 */
    speechThreshold?: number;
    /** RMS threshold to stop detecting speech (0-1). Default: 0.005 */
    silenceThreshold?: number;
    /** Milliseconds to wait after last speech before emitting speech_end. Default: 800 */
    hangoverMs?: number;
    /** Minimum speech duration to be considered valid. Default: 100 */
    minSpeechMs?: number;
  }) {
    this.speechThreshold = options?.speechThreshold ?? 0.01;
    this.silenceThreshold = options?.silenceThreshold ?? 0.005;
    this.hangoverMs = options?.hangoverMs ?? 800;
    this.minSpeechMs = options?.minSpeechMs ?? 100;
  }

  process(chunk: AudioChunk): VADResult {
    const rms = computeRMS(chunk.data, chunk.bitDepth);
    this.energyHistory.push(rms);
    if (this.energyHistory.length > this.historySize) {
      this.energyHistory.shift();
    }

    const now = chunk.timestampMs;
    let event: VADEvent | undefined;

    if (!this.isSpeaking && rms >= this.speechThreshold) {
      // Speech started
      this.isSpeaking = true;
      this.speechStartMs = now;
      this.lastSpeechMs = now;
      event = { type: "speech_start", timestampMs: now };
    } else if (this.isSpeaking) {
      if (rms >= this.silenceThreshold) {
        // Still speaking
        this.lastSpeechMs = now;
      } else if (now - this.lastSpeechMs >= this.hangoverMs) {
        // Silence exceeded hangover — speech ended
        const durationMs = this.lastSpeechMs - this.speechStartMs;
        if (durationMs >= this.minSpeechMs) {
          event = {
            type: "speech_end",
            timestampMs: now,
            durationMs,
          };
        }
        this.isSpeaking = false;
      }
    }

    return {
      isSpeech: this.isSpeaking,
      confidence: rms >= this.speechThreshold ? Math.min(rms / this.speechThreshold, 1) : 0,
      event,
    };
  }

  reset(): void {
    this.isSpeaking = false;
    this.speechStartMs = 0;
    this.lastSpeechMs = 0;
    this.energyHistory = [];
  }

  /** Get the average energy level over the recent history */
  get averageEnergy(): number {
    if (this.energyHistory.length === 0) return 0;
    return (
      this.energyHistory.reduce((a, b) => a + b, 0) /
      this.energyHistory.length
    );
  }
}

/**
 * Compute RMS (Root Mean Square) energy of a PCM audio buffer.
 * Normalized to 0-1 range.
 */
function computeRMS(buffer: Buffer, bitDepth: number): number {
  const samples = bitDepth === 16 ? buffer.length / 2 : buffer.length;
  if (samples === 0) return 0;

  let sumSquares = 0;
  const maxVal = bitDepth === 16 ? 32768 : 128;

  for (let i = 0; i < buffer.length; i += bitDepth === 16 ? 2 : 1) {
    const sample =
      bitDepth === 16
        ? buffer.readInt16LE(i) / maxVal
        : (buffer[i] - 128) / maxVal;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

export function createEnergyVAD(options?: {
  speechThreshold?: number;
  silenceThreshold?: number;
  hangoverMs?: number;
}): EnergyVAD {
  return new EnergyVAD(options);
}
