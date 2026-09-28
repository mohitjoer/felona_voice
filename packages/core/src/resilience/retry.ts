/**
 * Retry with exponential backoff and jitter, plus a circuit breaker.
 *
 * Provider calls fail transiently (socket resets, 502s from a vendor edge,
 * timeouts). Without retry a single blip ends a customer's call; without a
 * circuit breaker a dead provider is hammered once per turn by every
 * concurrent call.
 *
 * Retries are deliberately *not* applied to streaming audio or to requests
 * that may have been received by the server. Only idempotent reads and
 * connection-establishment calls should use these helpers.
 */

/** Options for {@link retry}. */
export interface RetryOptions {
  /** Total attempts including the first. `1` disables retry. */
  maxAttempts?: number;
  /** Delay before the first retry, doubled each attempt thereafter. */
  baseDelayMs?: number;
  /** Upper bound on any single delay. */
  maxDelayMs?: number;
  /** Random fraction of the delay to add, to avoid retry storms. */
  jitterRatio?: number;
  /**
   * Decides whether a failure is worth another attempt. Defaults to retrying
   * only errors tagged `retryable` via {@link markRetryable}.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic tests. */
  random?: () => number;
}

/** Thrown/attached marker to opt an error into the default retry policy. */
const RETRYABLE = Symbol("felona.retryable");

/**
 * Tags an error as safe to retry. Errors without this tag are treated as
 * permanent by {@link retry} unless a custom `isRetryable` is supplied.
 */
export function markRetryable<T extends Error>(error: T): T {
  Object.defineProperty(error, RETRYABLE, { value: true, enumerable: false });
  return error;
}

/** True when the error was tagged with {@link markRetryable}. */
export function isRetryableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[RETRYABLE] === true
  );
}

/**
 * HTTP statuses worth retrying: rate limits and transient server/gateway
 * errors. 4xx other than 408/429 indicate a bad request that will not succeed
 * on a second attempt.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * Runs `fn`, retrying transient failures with exponential backoff and jitter.
 *
 * The final error is rethrown unchanged so callers still see the real cause.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    jitterRatio = 0.25,
    isRetryable = isRetryableError,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Jitter is additive so a fleet of callers does not resynchronise.
      const delayMs = Math.round(
        exponential * (1 + (random() * 2 - 1) * jitterRatio),
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}
