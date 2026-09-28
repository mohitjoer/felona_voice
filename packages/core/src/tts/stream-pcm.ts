/**
 * Shared streaming helper for TTS providers.
 *
 * Every provider does the same thing: POST to a vendor endpoint, read raw PCM
 * off the response body, and yield timestamped chunks. Getting that right means
 * bounding the request, retrying before any audio has been delivered, and —
 * the part that is easy to miss — actually aborting the HTTP stream when the
 * caller barges in.
 *
 * `releaseLock()` alone does not free the socket. Once the consumer stops
 * iterating, the generator's `finally` runs, but the connection stays open with
 * the vendor still writing into it.
 */

import { fetchWithTimeout } from "../resilience/timeout.js";
import { isRetryableStatus, markRetryable, retry } from "../resilience/retry.js";
import type { AudioChunk } from "../types.js";

/** Options for {@link streamPcm}. */
export interface StreamPcmOptions {
  /** Sample rate of the PCM being returned, for timestamp computation. */
  sampleRate: number;
  /** Prefix used in error messages, e.g. `"OpenAI TTS"`. */
  providerLabel: string;
  /** Cancels the request, e.g. on barge-in. */
  signal?: AbortSignal;
  /** Deadline in ms. Defaults to 15s. */
  timeoutMs?: number;
}

/** HTTP failure, tagged so the retry policy can tell a 503 from a 400. */
class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Yields timestamped PCM chunks from a streaming TTS endpoint.
 *
 * Retries apply to connection establishment only, never mid-stream: by the time
 * audio is flowing the caller is already hearing speech, so restarting the
 * utterance would be worse than a short gap.
 */
export async function* streamPcm(
  url: string,
  init: RequestInit,
  options: StreamPcmOptions,
): AsyncGenerator<AudioChunk, void, undefined> {
  const { sampleRate, providerLabel, signal, timeoutMs } = options;

  const handle = await retry(async () => {
    const attempt = await fetchWithTimeout(url, { timeoutMs, signal, init });
    if (attempt.response.ok) return attempt;

    const body = await attempt.response.text().catch(() => "");
    attempt.cancel();
    const error = new ProviderError(
      attempt.response.status,
      `${providerLabel} failed: ${attempt.response.status} ${attempt.response.statusText}`,
    );
    // 5xx and 429 are worth another attempt; a 400 means the request itself is
    // wrong, so retrying it just burns the caller's time.
    if (isRetryableStatus(attempt.response.status)) markRetryable(error);
    if (body) error.message += ` — ${body.slice(0, 200)}`;
    throw error;
  });

  if (!handle.response.body) {
    handle.cancel();
    throw new Error(`${providerLabel} returned no response body`);
  }

  const reader = handle.response.body.getReader();
  const bytesPerSecond = sampleRate * 2; // 16-bit mono
  let timestampMs = 0;
  // True only when we consumed the stream to its natural end. A consumer that
  // breaks out (barge-in) leaves this false, which is the signal to abort.
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value || value.length === 0) continue;

      yield {
        data: Buffer.from(value),
        sampleRate,
        channels: 1,
        bitDepth: 16,
        timestampMs,
      };

      timestampMs += (value.length / bytesPerSecond) * 1000;
    }
  } finally {
    // Releasing the lock on a partially-read stream leaves the connection
    // open with the vendor still writing into it, so abort instead.
    if (drained) reader.releaseLock();
    handle.cancel();
  }
}
