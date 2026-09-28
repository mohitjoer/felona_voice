/**
 * Bounded audio buffer for batch (non-streaming) STT providers.
 *
 * Batch providers accumulate a whole utterance before sending it. If a turn
 * never endpointed — a caller who speaks continuously, or a VAD that latches —
 * an unbounded array grows for the entire call: 32 KB/s at 16 kHz mono 16-bit
 * means roughly 19 MB per ten minutes, per concurrent call, all of which then
 * gets concatenated in one allocation.
 *
 * When the cap is hit the oldest audio is discarded, because recent speech is
 * what the recogniser can still act on. Dropping the tail instead would leave
 * the recogniser working from a fragment with no context.
 */

/** Default cap: ~60s of 16 kHz mono 16-bit audio. */
export const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 60 * 16000 * 2;

export class AudioBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private droppedBytes = 0;

  private readonly onDrop?: (bytes: number) => void;
  private readonly maxBytes = DEFAULT_MAX_BUFFERED_AUDIO_BYTES;

  constructor(options?: { onDrop?: (bytes: number) => void }) {
    this.onDrop = options?.onDrop;
  }

  /** Total bytes currently held. */
  get byteLength(): number {
    return this.bytes;
  }

  /** Total bytes discarded to stay within the cap. */
  get dropped(): number {
    return this.droppedBytes;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /** Appends audio, trimming the oldest chunks if the cap is exceeded. */
  push(data: Buffer): void {
    // A single chunk larger than the whole cap would loop forever below, and
    // keeping it defeats the purpose of the cap.
    if (data.length >= this.maxBytes) {
      this.clear();
      this.chunks.push(data);
      this.bytes = data.length;
      return;
    }

    this.chunks.push(data);
    this.bytes += data.length;

    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      const size = dropped?.length ?? 0;
      this.bytes -= size;
      this.droppedBytes += size;
      this.onDrop?.(size);
    }
  }

  /**
   * Returns everything buffered and resets, so concurrent writes during
   * transcription land in the next turn rather than being lost or duplicated.
   */
  take(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    const full = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    return full;
  }

  /** Discards buffered audio without returning it. */
  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
