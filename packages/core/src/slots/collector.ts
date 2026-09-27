import {
  DEFAULT_PROMPTS,
  EXTRACTORS,
  VALIDATORS,
  type SlotType,
  type ValidationResult,
} from "./extractors.js";

export interface SlotDefinition {
  /** Key the collected value is stored under. */
  name: string;
  /** Extraction and validation strategy. */
  type: SlotType;
  /** What to ask the caller. Falls back to type-specific wording. */
  prompt?: string;
  /** When false, the collector completes without it. Default: true */
  required?: boolean;
  /**
   * How many times to re-ask after an unusable answer before giving up on this
   * slot. Default: 3. A slot that exhausts its attempts is skipped, so one bad
   * answer cannot deadlock a call.
   */
  maxAttempts?: number;
  /** Override the built-in validator. */
  validate?: (value: string) => ValidationResult;
  /**
   * Only attempt this slot when the utterance looks relevant.
   *
   * Without it, a type-specific extractor can fire on unrelated speech — a
   * five-digit order number reads as a ZIP code. Returning false skips the slot
   * and leaves it for a later turn.
   */
  shouldAttempt?: (text: string) => boolean;
}

export interface SlotRecord {
  name: string;
  type: SlotType;
  value: unknown;
  /** How many usable answers were collected. */
  attempts: number;
  /** True once a value passed validation. */
  filled: boolean;
  /** True once the slot is no longer being pursued. */
  abandoned: boolean;
}

export interface IngestResult {
  /** Slots filled by this utterance. */
  filled: SlotRecord[];
  /** Slots that produced a value which failed validation. */
  rejected: Array<{ name: string; message: string }>;
  /** Whether every required slot is now filled. */
  complete: boolean;
  /** The prompt to speak next, or null when the collection is finished. */
  prompt: string | null;
}

/**
 * Collects typed values across a live conversation.
 *
 * Handles the things that make real collection fail: spoken rather than typed
 * input, self-corrections ("no, it's John"), repeated bad answers, and callers
 * who answer out of order. One instance per session — it holds the partially
 * collected state, and callers are responsible for discarding it when the call
 * ends, consistent with the framework's zero-persistence default.
 */
export class SlotCollector {
  private readonly definitions: SlotDefinition[];
  private readonly records = new Map<string, SlotRecord>();

  constructor(definitions: SlotDefinition[]) {
    if (definitions.length === 0) {
      throw new Error("SlotCollector requires at least one slot definition");
    }

    const seen = new Set<string>();
    for (const definition of definitions) {
      if (!definition.name) {
        throw new Error("Every slot definition requires a name");
      }
      if (seen.has(definition.name)) {
        throw new Error(`Duplicate slot name "${definition.name}"`);
      }
      seen.add(definition.name);
    }

    this.definitions = definitions;
    for (const definition of definitions) {
      this.records.set(definition.name, {
        name: definition.name,
        type: definition.type,
        value: undefined,
        attempts: 0,
        filled: false,
        abandoned: false,
      });
    }
  }

  /** Collected values, keyed by slot name. */
  get slots(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, record] of this.records) {
      if (record.filled) out[name] = record.value;
    }
    return out;
  }

  /** Every slot record, including unfilled ones. */
  get state(): SlotRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Names of required slots that are still outstanding. */
  get missing(): string[] {
    return this.definitions
      .filter((definition) => definition.required !== false)
      .filter((definition) => !this.records.get(definition.name)!.filled)
      .map((definition) => definition.name);
  }

  /** True once every required slot is filled. */
  get complete(): boolean {
    return this.missing.length === 0;
  }

  /**
   * The next thing to ask.
   *
   * Prefers the earliest unfilled slot, so the caller is walked through the
   * fields in a predictable order.
   */
  nextPrompt(): string | null {
    for (const definition of this.definitions) {
      const record = this.records.get(definition.name)!;
      if (record.filled) continue;

      if (definition.required === false) continue;
      if (record.attempts >= (definition.maxAttempts ?? 3)) {
        // Attempts exhausted: stop asking rather than looping on a caller who
        // cannot or will not answer.
        continue;
      }

      return definition.prompt ?? DEFAULT_PROMPTS[definition.type];
    }
    return null;
  }

  /**
   * Feed the caller's latest utterance.
   *
   * Attempts every slot that is still open. A slot whose extractor fires but
   * whose value fails validation is counted as an attempt, which is what drives
   * re-prompting and eventual abandonment.
   */
  ingest(text: string): IngestResult {
    const filled: SlotRecord[] = [];
    const rejected: Array<{ name: string; message: string }> = [];

    if (!text.trim()) {
      return { filled, rejected, complete: this.complete, prompt: this.nextPrompt() };
    }

    for (const definition of this.definitions) {
      const record = this.records.get(definition.name)!;
      if (record.filled || record.abandoned) continue;

      const maxAttempts = definition.maxAttempts ?? 3;
      if (record.attempts >= maxAttempts) {
        record.abandoned = true;
        continue;
      }

      if (definition.shouldAttempt && !definition.shouldAttempt(text)) continue;

      const extraction = EXTRACTORS[definition.type](text);
      if (!extraction.found || extraction.value === undefined) continue;

      const validate = definition.validate ?? VALIDATORS[definition.type];
      const validation = validate(extraction.value);

      if (!validation.valid) {
        record.attempts++;
        rejected.push({
          name: definition.name,
          message: validation.message ?? `That does not look like a ${definition.type}.`,
        });
        if (record.attempts >= maxAttempts) {
          record.abandoned = true;
        }
        continue;
      }

      record.value = validation.value ?? extraction.value;
      record.filled = true;
      record.attempts++;
      filled.push({ ...record });
    }

    return {
      filled,
      rejected,
      complete: this.complete,
      prompt: this.complete ? null : this.nextPrompt(),
    };
  }

  /**
   * Seed a slot directly, for values already known (caller ID, a web form).
   * Validation still applies, so a bad seed is reported rather than trusted.
   */
  seed(name: string, value: string): boolean {
    const definition = this.definitions.find((d) => d.name === name);
    const record = this.records.get(name);
    if (!definition || !record || record.filled) return false;

    const validate = definition.validate ?? VALIDATORS[definition.type];
    const validation = validate(value);
    if (!validation.valid) return false;

    record.value = validation.value ?? value;
    record.filled = true;
    return true;
  }

  /** Discard all collected state. */
  reset(): void {
    for (const record of this.records.values()) {
      record.value = undefined;
      record.attempts = 0;
      record.filled = false;
      record.abandoned = false;
    }
  }
}

/** Factory, matching the createX convention used across the codebase. */
export function createSlotCollector(
  definitions: SlotDefinition[],
): SlotCollector {
  return new SlotCollector(definitions);
}
