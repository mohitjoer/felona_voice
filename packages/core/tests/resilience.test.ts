import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  TimeoutError,
  isAbortError,
  isTimeoutError,
  fetchWithTimeout,
} from "../src/resilience/timeout.js";
import {
  isRetryableError,
  isRetryableStatus,
  markRetryable,
  retry,
} from "../src/resilience/retry.js";

/** Installs a fetch stub and returns the mock plus a restore function. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const mock = vi.fn(impl as typeof fetch);
  globalThis.fetch = mock;
  return { mock, restore: () => { globalThis.fetch = original; } };
}

describe("fetchWithTimeout", () => {
  it("passes a signal to fetch so the socket is really torn down", async () => {
    const { mock, restore } = stubFetch(async (_u, init) => {
      // The deadline is only meaningful if fetch received a signal.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response("ok");
    });
    try {
      await fetchWithTimeout("https://example.test/x", { timeoutMs: 50 });
      expect(mock).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("aborts and throws TimeoutError when the deadline passes", async () => {
    const { restore } = stubFetch(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    try {
      await expect(
        fetchWithTimeout("https://example.test/slow", { timeoutMs: 20 }),
      ).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      restore();
    }
  });

  it("honours a caller signal and reports an abort, not a timeout", async () => {
    const controller = new AbortController();
    const { restore } = stubFetch(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    try {
      const pending = fetchWithTimeout("https://example.test/x", {
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      controller.abort();
      const error = await pending.catch((e) => e);
      expect(isAbortError(error)).toBe(true);
      // A caller cancellation must not be reported as our deadline expiring.
      expect(error).not.toBeInstanceOf(TimeoutError);
    } finally {
      restore();
    }
  });

  it("fails fast when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { mock, restore } = stubFetch(async () => new Response("never"));
    try {
      await expect(
        fetchWithTimeout("https://example.test/x", { signal: controller.signal }),
      ).rejects.toThrow();
      // No point opening a socket we are about to abandon.
      expect(mock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("cancel() aborts an in-flight body so the socket is released", async () => {
    let captured: AbortSignal | undefined;
    const { restore } = stubFetch(async (_u, init) => {
      captured = init?.signal ?? undefined;
      return new Response("partial");
    });
    try {
      const handle = await fetchWithTimeout("https://example.test/stream");
      expect(captured?.aborted).toBe(false);
      handle.cancel();
      expect(captured?.aborted).toBe(true);
    } finally {
      restore();
    }
  });

  it("passes an unaborted signal when the timeout is disabled", async () => {
    let signal: AbortSignal | undefined;
    const { restore } = stubFetch(async (_u, init) => {
      signal = init?.signal ?? undefined;
      return new Response("ok");
    });
    try {
      const handle = await fetchWithTimeout("https://example.test/x", {
        timeoutMs: 0,
      });
      // No deadline means nothing will abort it except the caller.
      expect(signal?.aborted).toBe(false);
      handle.cancel();
      expect(signal?.aborted).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("retry", () => {
  const noSleep = async () => {};

  it("returns the first successful result without sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries a tagged error and succeeds", async () => {
    const fn = vi
      .fn<[number], Promise<string>>()
      .mockRejectedValueOnce(markRetryable(new Error("502")))
      .mockResolvedValue("ok");
    await expect(retry(fn, { sleep: noSleep, random: () => 0.5 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry an untagged error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("bad request");
    });
    await expect(retry(fn, { sleep: noSleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("rethrows the final error after exhausting attempts", async () => {
    const fn = vi.fn(async () => {
      throw markRetryable(new Error("still down"));
    });
    await expect(retry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow(
      "still down",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially and respects the cap", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw markRetryable(new Error("down"));
    });
    await retry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 400,
      jitterRatio: 0,
      sleep: async (ms) => { delays.push(ms); },
    }).catch(() => {});
    expect(delays).toEqual([100, 200, 400, 400]);
  });

  it("keeps jitter inside the configured ratio", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw markRetryable(new Error("down"));
    });
    await retry(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      jitterRatio: 0.5,
      random: () => 1,
      sleep: async (ms) => { delays.push(ms); },
    }).catch(() => {});
    // random()===1 is the maximum jitter excursion: 100 * 1.5
    expect(delays[0]).toBe(150);
  });
});




describe("markRetryable", () => {
  it("tags the error without polluting JSON output", () => {
    const error = markRetryable(new Error("x"));
    expect(isRetryableError(error)).toBe(true);
    expect(JSON.stringify({ error })).not.toContain("retryable");
  });
});
