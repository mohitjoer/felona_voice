/**
 * DTMF (keypad) input collection.
 *
 * Callers pressing keys on a handset produce tones, not speech, so they never
 * reach the STT stream. This collects those digits into a buffer and reports
 * when an expected-length value is complete — the mechanism behind PIN entry,
 * IVR menu navigation and card capture.
 */

export interface DTMFOptions {
  /**
   * Number of digits that completes an entry (e.g. 4 for a PIN).
   * Omit or 0 for open-ended collection, where the caller relies on
   * `terminateOn` or an explicit `submit()`.
   */
  expectedDigits?: number;
  /** Digit that marks the end of an entry, e.g. "#". Omit to disable. */
  terminateOn?: string;
  /**
   * Reset the buffer after this long without a digit. Prevents a stale
   * partial entry from silently completing a later one.
   */
  idleTimeoutMs?: number;
  /** Maximum digits retained, to bound memory. Default: 32 */
  maxDigits?: number;
}

/** A completed DTMF entry. */
export interface DTMFEntry {
  digits: string;
  complete: boolean;
  /** True when completion came from an explicit terminator rather than length. */
  terminated: boolean;
}

/**
 * Accumulates keypad digits for one session.
 *
 * One instance per session. Not thread-safe by design: it is only ever touched
 * from the transport's message handler.
 */
export class DTMFCollector {
  private digits = "";
  private readonly expectedDigits: number;
  private readonly terminateOn?: string;
  private readonly idleTimeoutMs: number;
  private readonly maxDigits: number;
  private lastDigitAtMs = 0;

  constructor(options?: DTMFOptions) {
    this.expectedDigits = options?.expectedDigits ?? 0;
    this.terminateOn = options?.terminateOn;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 10_000;
    this.maxDigits = options?.maxDigits ?? 32;
  }

  /** Digits collected so far. */
  get value(): string {
    return this.digits;
  }

  /** True when `expectedDigits` has been reached. */
  get complete(): boolean {
    return this.expectedDigits > 0 && this.digits.length >= this.expectedDigits;
  }

  /**
   * Add a digit.
   *
   * Returns the resulting entry, with `complete` set when the entry is ready to
   * be consumed. Returns null when the digit was rejected (empty, too long, or
   * discarded by the idle timeout).
   */
  push(digit: string, nowMs = Date.now()): DTMFEntry | null {
    if (!digit || digit.length !== 1) return null;

    // A long gap means the previous entry was abandoned, not continued.
    if (this.lastDigitAtMs > 0 && nowMs - this.lastDigitAtMs > this.idleTimeoutMs) {
      this.reset();
    }
    this.lastDigitAtMs = nowMs;

    if (this.terminateOn && digit === this.terminateOn) {
      const entry: DTMFEntry = { digits: this.digits, complete: true, terminated: true };
      this.reset();
      return entry;
    }

    if (this.digits.length >= this.maxDigits) return null;

    this.digits += digit;

    if (this.complete) {
      const entry: DTMFEntry = { digits: this.digits, complete: true, terminated: false };
      this.reset();
      return entry;
    }

    return { digits: this.digits, complete: false, terminated: false };
  }

  /**
   * Take the buffered digits, whether or not the entry is complete.
   * Use for open-ended collection where the caller knows when to stop.
   */
  submit(): DTMFEntry {
    const entry: DTMFEntry = { digits: this.digits, complete: true, terminated: false };
    this.reset();
    return entry;
  }

  /** Discard the buffer. */
  reset(): void {
    this.digits = "";
    this.lastDigitAtMs = 0;
  }
}

/** Factory, matching the createX convention used across the codebase. */
export function createDTMFCollector(options?: DTMFOptions): DTMFCollector {
  return new DTMFCollector(options);
}
