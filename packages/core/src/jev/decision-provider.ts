import { fetchWithTimeout, isAbortError } from "../resilience/timeout.js";
import { isRetryableStatus, markRetryable, retry } from "../resilience/retry.js";
import type {
  DecisionProvider,
  DecisionQuestion,
  DecisionRequestOptions,
  DecisionResult,
  DecisionAnswers,
  DecisionUsage,
} from "../types.js";

/**
 * A {@link DecisionProvider} speaking the System One wire protocol:
 * a `state` plus a map of typed `questions`, answered with typed answers and
 * their probabilities.
 *
 * One implementation covers every server that serves this shape — the hosted
 * service, the local adapters, and the router endpoints that resell it — so
 * swapping backends is a base URL rather than a rewrite. They differ in three
 * ways worth knowing about, all handled here:
 *
 * - **Option budget.** Budgets run from 100 options (local servers using a
 *   frozen encoder) to 255. Exceeding it returns 413 or 422 naming the
 *   question, so a 400 from a provider is surfaced rather than swallowed.
 * - **Confidence formula.** Some servers report `(n·p_max − 1)/(n − 1)` and
 *   others 1 − normalised entropy. A threshold tuned on one does not transfer,
 *   which is why `answerConfidence` is exposed separately from `confidence`.
 * - **Model echo.** Some echo the requested name, others name the checkpoint
 *   that answered. `model` is whatever came back, so pinning is verifiable.
 */

/** Options for {@link SystemOneDecisionProvider}. */
export interface SystemOneDecisionProviderOptions {
  /** Default: the hosted System One endpoint. */
  baseUrl?: string;
  /** Required for hosted endpoints; usually not for a local server. */
  apiKey?: string;
  /**
   * Model to pin. Default: `"jev-latest"`.
   *
   * Prefer an exact version over a moving alias: a calibrated model's
   * thresholds shift between releases, and a shift nobody planned for quietly
   * changes which decisions clear a confidence gate.
   */
  model?: string;
  /** Deadline in ms per request. Default: 5000. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Provider label used in errors. */
  name?: string;
}

/** The endpoint path the System One protocol is served on. */
const DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Largest option count any known server accepts for one question. */
const MAX_CHOICE_OPTIONS = 255;

interface WireAnswer {
  type?: string;
  choice?: unknown;
  noul?: unknown;
  score?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
  answer_confidence?: unknown;
  legend?: unknown;
}

interface WireResponse {
  answers?: unknown;
  model?: unknown;
  usage?: unknown;
}

/** A non-2xx or malformed reply from the decision endpoint. */
export class DecisionRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DecisionRequestError";
    this.status = status;
  }
}

/**
 * True when another attempt could plausibly succeed.
 *
 * A refused connection while a local server is still booting is worth retrying;
 * a 422 saying the request was rejected is not, and repeating it only spends a
 * turn's latency to be told the same thing. Retries are bounded because a
 * decision request has no side effects — but a wrong-shaped request is wrong on
 * every attempt.
 */
function isWorthRetrying(error: unknown): boolean {
  if (error instanceof DecisionRequestError) {
    return isRetryableStatus(error.status);
  }
  // A thrown network error (connection refused, DNS failure) has no status.
  return true;
}

export class SystemOneDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: SystemOneDecisionProviderOptions = {}) {
    this.name = options.name ?? "systemone";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.headers = { ...options.headers };
  }

  async decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
    options: DecisionRequestOptions = {},
  ): Promise<DecisionResult> {
    assertDecisionRequest(state, questions);

    const body = JSON.stringify({ state, model: this.model, questions });

    const handle = await retry(
      () =>
        fetchWithTimeout(`${this.baseUrl}/v1/systemone`, {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? this.timeoutMs,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
              ...this.headers,
            },
            body,
          },
        }).then(async (attempt) => {
          if (attempt.response.ok) return attempt;

          const text = await attempt.response.text().catch(() => "");
          attempt.cancel();

          const error = new DecisionRequestError(
            `${this.name} decision failed: ${attempt.response.status} ${attempt.response.statusText}${
              text ? ` — ${text.slice(0, 300)}` : ""
            }`,
            attempt.response.status,
          );
          if (isRetryableStatus(attempt.response.status)) markRetryable(error);
          throw error;
        }),
      { isRetryable: (error) => !isAbortError(error) && isWorthRetrying(error) },
    );

    let payload: WireResponse;
    try {
      payload = (await handle.response.json()) as WireResponse;
    } catch (error) {
      throw new DecisionRequestError(
        `${this.name} returned a body that is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        handle.response.status,
      );
    } finally {
      handle.cancel();
    }

    return parseDecisionResponse(this.name, questions, payload);
  }
}

/**
 * Create a {@link DecisionProvider} over the System One protocol.
 */
export function createDecisionProvider(
  options: SystemOneDecisionProviderOptions = {},
): SystemOneDecisionProvider {
  return new SystemOneDecisionProvider(options);
}

/**
 * Rejects a request the servers would refuse anyway, naming the reason.
 *
 * A 400 from the endpoint is a round trip spent to learn something known here.
 * More importantly, these are the inputs where a wrong answer silently degrades
 * routing rather than erroring: an empty state reads as "nothing to decide on",
 * and a one-option choice is a decision the model cannot make.
 */
export function assertDecisionRequest(
  state: string,
  questions: Record<string, DecisionQuestion>,
): void {
  if (typeof state !== "string" || state.trim() === "") {
    throw new Error(
      "A decision request needs a non-empty state — an empty one has nothing to decide about, and the endpoint would answer it as a confident negative.",
    );
  }

  const ids = Object.keys(questions ?? {});
  if (ids.length === 0) {
    throw new Error(
      "A decision request needs at least one question — JEV asks one per action, so none means no routing.",
    );
  }

  for (const id of ids) {
    const question = questions[id];
    const label = `Question "${id}"`;

    if (!question || typeof question !== "object") {
      throw new Error(`${label} is missing or is not a question object.`);
    }
    if (!question.instructions || question.instructions.trim() === "") {
      throw new Error(
        `${label} needs instructions. The question id is never sent to the model, so a question without instructions has no question.`,
      );
    }

    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length < 2) {
        throw new Error(
          `${label} is a choice with ${options.length} option(s). A choice needs at least two — with one there is no decision to make.`,
        );
      }
      if (options.length > MAX_CHOICE_OPTIONS) {
        throw new Error(
          `${label} declares ${options.length} options, over the ${MAX_CHOICE_OPTIONS} any server accepts. Narrow the label set or shortlist before asking.`,
        );
      }
    }

    if (question.type === "score") {
      const levels = question.criteria ?? [];
      if (levels.length < 2) {
        throw new Error(
          `${label} is a score with ${levels.length} level(s). An ordered score needs at least two, lowest first.`,
        );
      }
      const undescribed = levels.findIndex((level) => !level || level.trim() === "");
      if (undescribed !== -1) {
        throw new Error(
          `${label} level ${undescribed} has no description. A level is read on its own, so "medium" without what it means is not a level.`,
        );
      }
    }
  }
}

/**
 * Turns a wire response into typed answers.
 *
 * Answered questions are checked against what was asked. A `choice` naming an
 * option that was never offered is not a near-miss to route on: it means the
 * response and the request disagree, and accepting it would dispatch to an
 * action that does not exist.
 */
export function parseDecisionResponse(
  providerName: string,
  questions: Record<string, DecisionQuestion>,
  payload: WireResponse,
): DecisionResult {
  const raw = payload.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionRequestError(
      `${providerName} response has no "answers" object — routing cannot be decided from it.`,
      200,
    );
  }

  const answers: Record<string, DecisionAnswers> = {};

  for (const [id, question] of Object.entries(questions)) {
    const answer = (raw as Record<string, WireAnswer | undefined>)[id];
    if (!answer || typeof answer !== "object") {
      throw new DecisionRequestError(
        `${providerName} did not answer question "${id}". Every question asked must come back answered; a missing one means the response cannot be routed on.`,
        200,
      );
    }

    answers[id] = parseAnswer(providerName, id, question, answer);
  }

  const result: DecisionResult = { answers };

  if (typeof payload.model === "string" && payload.model !== "") {
    result.model = payload.model;
  }

  const usage = parseUsage(payload.usage);
  if (usage) result.usage = usage;

  return result;
}

function parseAnswer(
  providerName: string,
  id: string,
  question: DecisionQuestion,
  answer: WireAnswer,
): DecisionAnswers {
  const probabilities = parseProbabilities(answer.probabilities);

  if (question.type === "noul") {
    const noul = numberField(answer.noul, `${providerName} noul answer "${id}"`);
    if (noul === undefined) {
      throw new DecisionRequestError(
        `${providerName} returned no probability for noul question "${id}".`,
        200,
      );
    }
    return {
      noul,
      confidence: Math.max(noul, 1 - noul),
      ...(probabilities ? { probabilities } : {}),
    };
  }

  if (question.type === "score") {
    const legend = parseLegend(answer.legend, question.criteria);
    const levels = question.criteria.length;
    // With no distribution, the reported score is all there is. Returning the
    // raw value rather than 0 keeps a decision that clears a threshold usable.
    // A score is a level index, so the 0–1 probability bound does not apply.
    const score = indexField(answer.score, levels, `${providerName} score answer "${id}"`);
    const resolved = score ?? weightedLevel(probabilities, levels);
    if (resolved === undefined) {
      throw new DecisionRequestError(
        `${providerName} returned neither a score nor probabilities for score question "${id}".`,
        200,
      );
    }
    return {
      score: resolved,
      confidence: numberField(answer.confidence, "confidence"),
      ...(probabilities ? { probabilities } : {}),
      ...(legend ? { legend } : {}),
    };
  }

  const choice = typeof answer.choice === "string" ? answer.choice : undefined;
  if (!choice) {
    throw new DecisionRequestError(
      `${providerName} returned no choice for choice question "${id}".`,
      200,
    );
  }

  const offered = Object.keys(question.criteria);
  if (!offered.includes(choice)) {
    throw new DecisionRequestError(
      `${providerName} chose "${choice}" for question "${id}", which was not one of the offered options (${offered.join(", ")}). Routing to an action that does not exist is not a decision.`,
      200,
    );
  }

  // Prefer the returned distribution. When it is absent, fall back to certainty
  // on the chosen option so the fallback threshold still has something to read.
  const resolved =
    probabilities ??
    (Object.fromEntries(
      offered.map((option) => [option, option === choice ? 1 : 0]),
    ) as Record<string, number>);

  return {
    choice,
    probabilities: resolved,
    confidence:
      numberField(answer.confidence, "confidence") ??
      numberField(answer.answer_confidence, "answer_confidence"),
  };
}

function parseProbabilities(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const out: Record<string, number> = {};
  let found = false;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const score = numberField(raw, "probability");
    if (score !== undefined) {
      out[key] = score;
      found = true;
    }
  }

  return found ? out : undefined;
}

function parseLegend(
  value: unknown,
  levels: string[],
): Record<string, string> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, string>;
  }

  // Servers that omit a legend still describe the levels, in order.
  if (levels.length > 0) {
    return Object.fromEntries(levels.map((level, index) => [String(index), level]));
  }
  return undefined;
}

function parseUsage(value: unknown): DecisionUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const raw = value as Record<string, unknown>;
  // Token counts, not probabilities: the 0–1 bound does not apply.
  const inputTokens = countField(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = countField(raw.output_tokens ?? raw.outputTokens);

  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

/** Probability-weighted level index, matching the documented `score` semantics. */
function weightedLevel(
  probabilities: Record<string, number> | undefined,
  levels: number,
): number | undefined {
  if (!probabilities) return undefined;

  let total = 0;
  for (let index = 0; index < levels; index++) {
    total += probabilities[String(index)] ?? 0;
  }
  if (total <= 0) return undefined;

  let sum = 0;
  for (let index = 0; index < levels; index++) {
    sum += index * (probabilities[String(index)] ?? 0);
  }
  return sum / total;
}

/** A probability or confidence, which must land inside 0–1 to be gateable. */
function numberField(value: unknown, label: string): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) {
    throw new DecisionRequestError(
      `${label} is ${value}, outside 0–1. A probability out of range means the answer cannot be gated on.`,
      200,
    );
  }
  return value;
}

/** A position on an ordered scale, which may fall between levels. */
function indexField(
  value: unknown,
  levels: number,
  label: string,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value >= levels) {
    throw new DecisionRequestError(
      `${label} is ${value}, outside the ${levels} level(s) offered (0–${levels - 1}).`,
      200,
    );
  }
  return value;
}

/** A non-negative count, such as a token total. */
function countField(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}