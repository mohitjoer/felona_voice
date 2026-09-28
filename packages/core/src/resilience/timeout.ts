/**
 * Deadline and cancellation for a streaming provider request.
 *
 * Every outbound voice request needs a deadline. An unbounded `fetch` holds a
 * pipeline turn open indefinitely, and because the pipeline serialises turns
 * behind a single `isProcessing` flag, one hung request wedges the whole call.
 *
 * The deadline is only meaningful if the caller can also cancel the socket, so
 * this composes the timeout with the caller's own signal and passes the result
 * to `fetch` — rather than racing a timer against a request that keeps running.
 */

/** Options for {@link fetchWithTimeout}. */
export interface FetchTimeoutOptions {
  /** Milliseconds before the request is aborted. `0` or `Infinity` disables the timeout. */
  timeoutMs?: number;
  /**
   * Caller-supplied signal, e.g. a barge-in cancellation from the pipeline.
   * Composed with the timeout signal: whichever fires first wins.
   */
  signal?: AbortSignal;
  /** Passed through to `fetch` (method, headers, body, ...). */
  init?: RequestInit;
}

/** Default timeout for a provider request that does not specify one. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Error thrown when a request exceeds its deadline. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, url: string) {
    super(`Request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * True when the rejection was an abort — a timeout or a caller cancellation.
 *
 * Both are distinguished from a server error because neither is worth retrying:
 * the caller asked us to stop, or the request already ran too long.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

/** A response whose body the caller can release deterministically. */
export interface CancellableResponse {
  /** The underlying response. Read `body` as normal. */
  response: Response;
  /** Aborts the in-flight request and releases the socket. */
  cancel: () => void;
}

/**
 * Performs a `fetch` bounded by `timeoutMs` and optionally by `options.signal`.
 *
 * The abort is real, not a race: the composed signal reaches `fetch`, so an
 * overrunning request has its socket torn down rather than abandoned.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchTimeoutOptions = {},
): Promise<CancellableResponse> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, init } = options;

  const controller = new AbortController();
  const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;

  let timedOut = false;
  const timer = timeoutEnabled
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : undefined;
  // Never hold the event loop open just to time out a request.
  timer?.unref?.();

  const onExternalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const dispose = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  };

  // A signal that is already dead means the caller cancelled before we
  // started; opening a socket we would immediately abandon is pointless.
  if (signal?.aborted) {
    dispose();
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      response,
      cancel: () => {
        if (!controller.signal.aborted) controller.abort();
        dispose();
      },
    };
  } catch (error) {
    dispose();
    if (timedOut) throw new TimeoutError(timeoutMs, url);
    throw error;
  }
  // On success the timer is deliberately left armed, so a caller that
  // abandons the body can still rely on the deadline to free the socket.
  // `cancel()` clears it.
}
