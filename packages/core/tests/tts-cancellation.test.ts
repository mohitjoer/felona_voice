import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FelAgent, defineAction } from "../src/agent.js";
import { createDeepgramTTS } from "../src/tts/deepgram.js";
import { createOpenAITTS } from "../src/tts/openai.js";
import { streamPcm } from "../src/tts/stream-pcm.js";
import type { TTSProvider, TTSOptions, AudioChunk } from "../src/types.js";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(impl as typeof fetch) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

/**
 * A Response whose body streams in pieces and can be abandoned.
 *
 * `signal` is honoured the way undici honours it: aborting cancels the body.
 * A stub that ignored the signal could not detect whether the transport
 * actually tore the request down.
 */
function streamingResponse(
  pieces: Uint8Array[],
  capture?: { cancelled: boolean },
  signal?: AbortSignal,
) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < pieces.length) {
        controller.enqueue(pieces[index++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      if (capture) capture.cancelled = true;
    },
  });
  if (signal) {
    // Recording the abort is enough. A real fetch tears the socket down, and
    // the source's own `cancel()` fires as a consequence. Calling
    // `body.cancel()` here would instead throw, because the consumer holds a
    // reader lock on the stream.
    const mark = () => {
      if (capture) capture.cancelled = true;
    };
    if (signal.aborted) mark();
    else signal.addEventListener("abort", mark, { once: true });
  }
  return new Response(body);
}

describe("TTS barge-in cancellation", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubFetch(async () => streamingResponse([new Uint8Array(320), new Uint8Array(320)]));
  });
  afterEach(() => { restore(); });

  it("aborts the response body when the consumer stops early", async () => {
    const capture = { cancelled: false };
    restore();
    restore = stubFetch(async (_url, init) =>
      streamingResponse(
        [new Uint8Array(320), new Uint8Array(320), new Uint8Array(320)],
        capture,
        init?.signal ?? undefined,
      ),
    );

    const tts = createDeepgramTTS({ apiKey: "k" });
    const controller = new AbortController();
    const chunks: AudioChunk[] = [];

    for await (const chunk of tts.synthesize("hello", { signal: controller.signal })) {
      chunks.push(chunk);
      // Simulate a barge-in after the first audio chunk.
      if (chunks.length === 1) controller.abort();
    }

    expect(chunks.length).toBeGreaterThan(0);
    // The vendor stream must actually be cancelled, not left buffering.
    expect(capture.cancelled).toBe(true);
  });

  it("drains normally when nothing interrupts", async () => {
    const tts = createDeepgramTTS({ apiKey: "k" });
    const chunks: AudioChunk[] = [];
    for await (const chunk of tts.synthesize("hello there")) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sampleRate).toBe(16000);
    // Timestamps must advance so playback does not stutter.
    expect(chunks[1].timestampMs).toBeGreaterThan(0);
  });

  it("streams OpenAI PCM at its native 24kHz", async () => {
    const tts = createOpenAITTS({ apiKey: "k" });
    const chunks: AudioChunk[] = [];
    for await (const chunk of tts.synthesize("hi")) chunks.push(chunk);
    expect(chunks[0].sampleRate).toBe(24000);
  });

  it("rejects a non-2xx without yielding audio", async () => {
    restore();
    restore = stubFetch(async () => new Response("nope", { status: 500 }));
    const tts = createDeepgramTTS({ apiKey: "k" });
    const chunks: AudioChunk[] = [];
    await expect(
      (async () => {
        for await (const c of tts.synthesize("hi")) chunks.push(c);
      })(),
    ).rejects.toThrow();
    expect(chunks).toHaveLength(0);
  });

  it("retries a 503 before yielding any audio", async () => {
    let call = 0;
    restore();
    restore = stubFetch(async () => {
      call++;
      return call === 1
        ? new Response("unavailable", { status: 503 })
        : streamingResponse([new Uint8Array(320)]);
    });
    const tts = createDeepgramTTS({ apiKey: "k" });
    const chunks: AudioChunk[] = [];
    for await (const c of tts.synthesize("hi")) chunks.push(c);
    expect(call).toBe(2);
    expect(chunks).toHaveLength(1);
  });

  it("throws when the provider returns no body", async () => {
    restore();
    restore = stubFetch(async () => new Response(null, { status: 200 }));
    const tts = createDeepgramTTS({ apiKey: "k" });
    await expect(
      (async () => {
        for await (const _ of tts.synthesize("hi")) { /* drain */ }
      })(),
    ).rejects.toThrow(/no response body/);
  });

  it("rejects immediately if the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tts = createDeepgramTTS({ apiKey: "k" });
    await expect(
      (async () => {
        for await (const _ of tts.synthesize("hi", { signal: controller.signal })) { /* drain */ }
      })(),
    ).rejects.toThrow();
  });
});

describe("streamPcm", () => {
  let restore: () => void;
  afterEach(() => { restore?.(); });

  it("rejects when the body is missing", async () => {
    restore = stubFetch(async () => new Response(null, { status: 200 }));
    const gen = streamPcm("https://x.test", {}, { sampleRate: 16000, providerLabel: "X" });
    await expect(gen.next()).rejects.toThrow(/no response body/);
  });
});

describe("interact() serialisation", () => {
  const build = () =>
    new FelAgent({
      name: "test",
      systemPrompt: "test",
      stt: { provider: "deepgram", apiKey: "k" },
      tts: { provider: "deepgram", apiKey: "k" },
      actions: [
        defineAction({ id: "slow", description: "slow action", handler: async () => "ok" }),
        defineAction({ id: "other", description: "unrelated topic", handler: async () => "ok" }),
      ],
    });

  /**
   * Wraps `jev.decide` so overlap between turns is observable.
   *
   * `decide` is the last await before the action handler runs, so two turns
   * overlapping here means their memory writes interleaved.
   */
  function trackDecisions(agent: FelAgent) {
    const events: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const original = agent.jevEngine.decide.bind(agent.jevEngine);
    (agent.jevEngine as unknown as { decide: unknown }).decide = async (
      context: { currentUtterance: string; turns: unknown[] },
    ) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push(`in:${context.currentUtterance}:${context.turns?.length ?? 0}`);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
      events.push("out");
      return original(context);
    };
    return { events, get maxConcurrent() { return maxConcurrent; } };
  }

  it("does not interleave turns on the same session", async () => {
    const agent = build();
    const tracker = trackDecisions(agent);

    await Promise.all([
      agent.interact({ userMessage: "first", sessionId: "shared" }),
      agent.interact({ userMessage: "second", sessionId: "shared" }),
    ]);

    // Turns on one session must not overlap: memory is read before decide()
    // and written after, so an overlap loses a turn.
    expect(tracker.maxConcurrent).toBe(1);
    // The second turn must see the first turn's history, not an empty context.
    const secondTurn = tracker.events.find((e) => e.startsWith("in:second"));
    expect(secondTurn).toBeDefined();
    expect(secondTurn).not.toMatch(/:0$/);
    await agent.stop();
  });

  it("keeps different sessions concurrent", async () => {
    const agent = build();
    const tracker = trackDecisions(agent);

    await Promise.all([
      agent.interact({ userMessage: "a", sessionId: "s1" }),
      agent.interact({ userMessage: "b", sessionId: "s2" }),
    ]);

    // Overlapping intervals mean both were in flight at once.
    expect(tracker.maxConcurrent).toBe(2);
    await agent.stop();
  });

  it("does not poison the queue when a turn throws", async () => {
    const agent = build();
    const original = agent.jevEngine.decide.bind(agent.jevEngine);
    let calls = 0;
    (agent.jevEngine as unknown as { decide: unknown }).decide = async (
      context: Parameters<typeof original>[0],
    ) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return original(context);
    };

    await expect(
      agent.interact({ userMessage: "x", sessionId: "q" }),
    ).rejects.toThrow("boom");
    // The next turn on the same session must still run.
    const second = await agent.interact({ userMessage: "y", sessionId: "q" });
    expect(second.text).toBe("ok");
    await agent.stop();
  });
});

describe("max call duration", () => {
  it("ends a call that outlives the configured limit", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FelAgent({
        name: "t",
        systemPrompt: "t",
        stt: { provider: "deepgram", apiKey: "k" },
        tts: { provider: "deepgram", apiKey: "k" },
        actions: [defineAction({ id: "a", description: "d", handler: async () => "x" })],
        maxCallDurationMs: 1_000,
        callSweepIntervalMs: 100,
      });

      const timeouts: unknown[] = [];
      agent.on("callTimeout", (e) => timeouts.push(e));

      // Register a pipeline the way handleConnect does, without a transport.
      const pipeline = { stop: vi.fn(async () => {}) };
      (agent as any).pipelines.set("long-call", pipeline);
      (agent as any).callStartedAt.set("long-call", Date.now());
      (agent as any).startCallSweeper();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(timeouts.length).toBeGreaterThan(0);
      expect((agent as any).pipelines.has("long-call")).toBe(false);
      expect(pipeline.stop).toHaveBeenCalled();
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Sanity: providers still satisfy the TTSProvider contract. */
describe("TTSProvider contract", () => {
  it("streams via synthesize()", async () => {
    const restore = stubFetch(async () => streamingResponse([new Uint8Array(64)]));
    try {
      const provider: TTSProvider = createDeepgramTTS({ apiKey: "k" });
      const opts: TTSOptions = { voice: "v" };
      const seen: AudioChunk[] = [];
      for await (const c of provider.synthesize("hi", opts)) seen.push(c);
      expect(seen).toHaveLength(1);
      expect(provider.name).toBe("deepgram");
    } finally {
      restore();
    }
  });
});
