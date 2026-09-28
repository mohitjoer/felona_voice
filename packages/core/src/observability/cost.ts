/**
 * Per-call cost accounting.
 *
 * A voice agent's unit of sale is a phone call, so cost has to be attributable
 * to a call — not just visible as a monthly total. Providers report tokens but
 * not money, and STT and TTS are billed by audio second, so this estimates from
 * duration and duration-equivalent token counts.
 *
 * Prices are the operator's to supply and change; defaults are not embedded
 * because a stale price silently misreports spend.
 */

import type { LLMUsage } from "../llm/index.js";
import type { MetricsRegistry } from "./metrics.js";

/** Published prices, in USD. Omitted components are simply not counted. */
export interface PriceTable {
  /** USD per million prompt tokens. */
  llmPromptPerMTok?: number;
  /** USD per million completion tokens. */
  llmCompletionPerMTok?: number;
  /** USD per minute of transcribed audio. */
  sttPerMinute?: number;
  /** USD per 1k characters of synthesised text. */
  ttsPer1kChars?: number;
}

/** One call's accumulated usage. */
export interface CallCost {
  llmPromptTokens: number;
  llmCompletionTokens: number;
  /** Seconds of audio sent to STT. */
  sttSeconds: number;
  /** Seconds of audio produced by TTS. */
  ttsSeconds: number;
  /** Characters sent to TTS. */
  ttsCharacters: number;
  /** Estimated USD, from the price table at the time of recording. */
  estimatedUsd: number;
}

/** A fresh, zeroed tally. */
export function emptyCallCost(): CallCost {
  return {
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    sttSeconds: 0,
    ttsSeconds: 0,
    ttsCharacters: 0,
    estimatedUsd: 0,
  };
}

/**
 * Tracks usage and cost for every live call.
 *
 * Entries are dropped when a call ends, so a long-lived process does not
 * accumulate one record per call it has ever served. Callers that need the
 * final figure must read it before teardown — `onCallCost` is the hook for
 * that, and it fires before the record is discarded.
 */
export class CostTracker {
  private readonly calls = new Map<string, CallCost>();
  private readonly prices: PriceTable;
  private readonly metrics?: MetricsRegistry;

  /** Notified as each call's tally changes, for live dashboards. */
  onCallCost?: (sessionId: string, cost: CallCost) => void;

  constructor(options?: { prices?: PriceTable; metrics?: MetricsRegistry }) {
    this.prices = options?.prices ?? {};
    this.metrics = options?.metrics;
  }

  /** The current tally for a call, creating it on first use. */
  get(sessionId: string): CallCost {
    let entry = this.calls.get(sessionId);
    if (!entry) {
      entry = emptyCallCost();
      this.calls.set(sessionId, entry);
    }
    return entry;
  }

  /** Adds LLM token usage. */
  addLLMUsage(sessionId: string, usage: LLMUsage | undefined): void {
    if (!usage) return;
    const entry = this.get(sessionId);
    entry.llmPromptTokens += usage.promptTokens;
    entry.llmCompletionTokens += usage.completionTokens;
    this.charge(sessionId, entry, this.llmCost(usage));

    this.metrics?.increment("felona_llm_prompt_tokens_total", usage.promptTokens);
    this.metrics?.increment("felona_llm_completion_tokens_total", usage.completionTokens);
  }

  /**
   * Adds audio duration.
   *
   * `direction` picks the price: caller audio is transcription, agent audio is
   * synthesis.
   */
  addAudioSeconds(sessionId: string, seconds: number, direction: "inbound" | "outbound"): void {
    if (seconds <= 0) return;
    const entry = this.get(sessionId);
    if (direction === "inbound") {
      entry.sttSeconds += seconds;
      this.charge(
        sessionId,
        entry,
        this.prices.sttPerMinute !== undefined ? (seconds / 60) * this.prices.sttPerMinute : 0,
      );
    } else {
      entry.ttsSeconds += seconds;
    }
  }

  /** Adds synthesised text, for character-billed TTS. */
  addSynthesizedCharacters(sessionId: string, characters: number): void {
    if (characters <= 0) return;
    const entry = this.get(sessionId);
    entry.ttsCharacters += characters;
    this.charge(
      sessionId,
      entry,
      this.prices.ttsPer1kChars !== undefined
        ? (characters / 1000) * this.prices.ttsPer1kChars
        : 0,
    );
  }

  /** The final tally for a call, without discarding it. */
  peek(sessionId: string): CallCost | undefined {
    const entry = this.calls.get(sessionId);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Removes a call's tally and returns it.
   *
   * The caller gets the final figure before it is dropped, so per-call cost
   * reporting does not require holding every call forever.
   */
  finish(sessionId: string): CallCost | undefined {
    const entry = this.calls.get(sessionId);
    this.calls.delete(sessionId);
    if (entry) {
      this.metrics?.increment("felona_call_cost_usd_total", entry.estimatedUsd);
    }
    return entry ? { ...entry } : undefined;
  }

  /** Live call ids being tracked. */
  tracked(): string[] {
    return [...this.calls.keys()];
  }

  /** Drops all tracked calls. */
  reset(): void {
    this.calls.clear();
  }

  private llmCost(usage: LLMUsage): number {
    const { llmPromptPerMTok, llmCompletionPerMTok } = this.prices;
    const prompt = llmPromptPerMTok !== undefined ? (usage.promptTokens / 1e6) * llmPromptPerMTok : 0;
    const completion =
      llmCompletionPerMTok !== undefined ? (usage.completionTokens / 1e6) * llmCompletionPerMTok : 0;
    return prompt + completion;
  }

  private charge(sessionId: string, entry: CallCost, amount: number): void {
    if (amount <= 0) return;
    entry.estimatedUsd += amount;
    this.onCallCost?.(sessionId, { ...entry });
  }
}

/** Factory for {@link CostTracker}. */
export function createCostTracker(options?: {
  prices?: PriceTable;
  metrics?: MetricsRegistry;
}): CostTracker {
  return new CostTracker(options);
}
