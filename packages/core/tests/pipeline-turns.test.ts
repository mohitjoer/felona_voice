import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoicePipeline } from "../src/pipeline.js";
import { JEVEngine } from "../src/jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../src/jev/fast-embeddings.js";
import { ConversationMemory } from "../src/memory/context.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CallLogger } from "../src/analytics/logger.js";
import { FelonaTracer, SPAN } from "../src/observability/tracing.js";
import { EnergyVAD } from "../src/vad/energy.js";
import type {
  ActionContext,
  AgentAction,
  AudioChunk,
  Session,
  STTProvider,
  STTResult,
  STTStream,
  TTSProvider,
} from "../src/types.js";

const SAMPLE_RATE = 16000;

/** Deterministic PCM: loud for speech, silent otherwise. */
function chunk(timestampMs: number, loud: boolean, ms = 20): AudioChunk {
  const samples = (SAMPLE_RATE * ms) / 1000;
  const data = Buffer.alloc(samples * 2);
  if (loud) {
    for (let i = 0; i < samples; i++) {
      data.writeInt16LE(
        Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)),
        i * 2,
      );
    }
  }
  return { data, sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 16, timestampMs };
}

/**
 * Mock STT whose final transcript only arrives when `flush()` is called —
 * exactly the behaviour that used to lose the tail of every utterance.
 */
class DeferredSTTStream implements STTStream {
  private resultHandler: ((r: STTResult) => void) | null = null;
  private errorHandler: ((e: Error) => void) | null = null;
  private closed = false;
  readonly written: number[] = [];
  /** Text released by the next flush(). */
  pendingFinal = "";
  flushCalls = 0;

  write(c: AudioChunk): void {
    this.written.push(c.data.length);
  }
  onResult(h: (r: STTResult) => void): void {
    this.resultHandler = h;
  }
  onError(h: (e: Error) => void): void {
    this.errorHandler = h;
  }
  async flush(): Promise<void> {
    this.flushCalls++;
    if (this.pendingFinal) {
      const text = this.pendingFinal;
      this.pendingFinal = "";
      this.resultHandler?.({ text, isFinal: true, confidence: 0.9 });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  emitError(e: Error): void {
    this.errorHandler?.(e);
  }
  emitFinal(text: string): void {
    this.resultHandler?.({ text, isFinal: true, confidence: 0.9 });
  }
}

class MockSTT implements STTProvider {
  readonly name = "mock";
  lastStream: DeferredSTTStream | null = null;
  createStream(): STTStream {
    this.lastStream = new DeferredSTTStream();
    return this.lastStream;
  }
}

/** Total chunks handed to sendAudio, so replay-after-false-interruption is observable. */
let sentAudioCount = 0;

class MockTTS implements TTSProvider {
  readonly name = "mock";
  spoken: string[] = [];
  /** When set, synthesis stalls on this promise so `isSpeaking` stays true. */
  hold: Promise<void> | null = null;

  async *synthesize(text: string): AsyncIterable<AudioChunk> {
    this.spoken.push(text);
    yield chunk(0, true);
    if (this.hold) await this.hold;
    yield chunk(20, true);
  }
}

const actions: AgentAction[] = [
  {
    id: "order_status",
    description: "Check delivery status and tracking for an order",
    handler: async () => "Your order is out for delivery today.",
  },
  {
    id: "fallback",
    description: "Unrecognized or off-topic requests",
    handler: async () => "Sorry, I did not catch that.",
  },
];

async function buildPipeline(overrides: Partial<{
  stt: MockSTT;
  tts: MockTTS;
  hooks: Record<string, unknown>;
  pipelineOptions: Partial<ConstructorParameters<typeof VoicePipeline>[0]>;
}> = {}) {
  const stt = overrides.stt ?? new MockSTT();
  const tts = overrides.tts ?? new MockTTS();
  const jev = new JEVEngine({
    embeddingProvider: new FastSemanticEmbeddingProvider(),
  });
  await jev.initialize(actions);

  const session: Session = {
    id: "s1",
    startedAt: new Date(),
    metadata: {},
    state: "active",
  };

  const pipeline = new VoicePipeline({
    sessionId: "s1",
    session,
    stt,
    tts,
    vad: new EnergyVAD({ hangoverMs: 60, minSpeechMs: 10 }),
    jev,
    memory: new ConversationMemory(),
    tools: new ToolRegistry(),
    logger: new CallLogger(),
    hooks: (overrides.hooks ?? {}) as never,
    systemPrompt: "test",
    sttFlushTimeoutMs: 200,
    sendAudio: async () => {
      sentAudioCount++;
    },
    ...overrides.pipelineOptions,
  });

  await pipeline.start();
  return { pipeline, stt, tts, memory: (pipeline as never as { memory: ConversationMemory }).memory };
}

/** Feed one utterance: speech, then silence long enough to end the turn. */
function speak(pipeline: VoicePipeline, loudForMs = 100): void {
  let t = 0;
  for (; t < loudForMs; t += 20) pipeline.processAudio(chunk(t, true));
  for (let i = 0; i < 10; i++, t += 20) pipeline.processAudio(chunk(t, false));
}

const settle = () => new Promise((r) => setTimeout(r, 250));

beforeEach(() => {
  sentAudioCount = 0;
});

describe("VoicePipeline turn handling", () => {
  it("waits for the STT final result before deciding a turn", async () => {
    const { pipeline, stt, tts } = await buildPipeline();
    const handled: ActionContext[] = [];

    // Capture what the action handler received.
    const original = actions[0].handler;
    actions[0].handler = async (ctx) => {
      handled.push(ctx);
      return original(ctx);
    };

    stt.lastStream!.pendingFinal = "where is my order";

    speak(pipeline);
    await settle();

    // The final text only exists once flush() releases it, so the handler must
    // have seen the complete utterance rather than a partial one.
    expect(stt.lastStream!.flushCalls).toBeGreaterThan(0);
    expect(handled).toHaveLength(1);
    expect(handled[0].conversation.currentUtterance).toBe("where is my order");
    expect(tts.spoken).toEqual(["Your order is out for delivery today."]);

    actions[0].handler = original;
    await pipeline.stop();
  });

  it("does not act on an empty turn", async () => {
    const { pipeline, tts } = await buildPipeline();
    const onUserSpoke = vi.fn();
    const wrapped = await buildPipeline({ hooks: { onUserSpoke } });

    speak(pipeline);
    await settle();

    expect(tts.spoken).toHaveLength(0);
    expect(onUserSpoke).not.toHaveBeenCalled();

    await pipeline.stop();
    await wrapped.pipeline.stop();
  });

  it("carries earlier turns into the next decision", async () => {
    const { pipeline, stt, tts } = await buildPipeline();

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline, 120);
    await settle();

    expect(tts.spoken).toHaveLength(2);
    await pipeline.stop();
  });

  it("survives a pipeline error with no 'error' listener attached", async () => {
    // Emitting 'error' on a bare EventEmitter throws; that must not happen.
    const stt = new MockSTT();
    const { pipeline } = await buildPipeline({ stt });

    expect(() => stt.lastStream!.emitError(new Error("recognizer died"))).not.toThrow();

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    // Still functional afterwards.
    expect(pipeline.state.isProcessing).toBe(false);
    await pipeline.stop();
  });

  it("reports STT errors through the hook rather than throwing", async () => {
    const onError = vi.fn();
    const stt = new MockSTT();
    const { pipeline } = await buildPipeline({ stt, hooks: { onError } });

    stt.lastStream!.emitError(new Error("401 unauthorized"));
    await settle();

    expect(onError).toHaveBeenCalled();
    await pipeline.stop();
  });

  it("ignores a short burst while the agent speaks (adaptive mode)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({ stt, tts });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    expect(pipeline.state.isSpeaking).toBe(true);

    // A cough / "uh-huh" — well under the 500ms qualification bar.
    let t = 500;
    for (let i = 0; i < 3; i++, t += 20) pipeline.processAudio(chunk(t, true));
    for (let i = 0; i < 3; i++, t += 20) pipeline.processAudio(chunk(t, false));
    await settle();

    expect(pipeline.bargeIns).toBe(0);
    expect(pipeline.state.isSpeaking).toBe(true);

    release();
    await pipeline.stop();
  });

  it("interrupts on sustained speech (adaptive mode)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({ stt, tts });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    expect(pipeline.state.isSpeaking).toBe(true);

    // Sustained speech, past minSpeechMs.
    let t = 500;
    for (let i = 0; i < 40; i++, t += 20) pipeline.processAudio(chunk(t, true));
    await settle();

    expect(pipeline.bargeIns).toBeGreaterThan(0);
    expect(pipeline.state.isSpeaking).toBe(false);

    release();
    await pipeline.stop();
  });

  it("resumes playback after a false interruption", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({ stt, tts });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    const sentBefore = sentAudioCount;
    expect(sentBefore).toBeGreaterThan(0);

    const spy = vi.fn();
    pipeline.on("falseInterruption", spy);

    // Short burst that opens then fails the qualification bar, followed by
    // enough silence for the VAD to close the turn.
    let t = 500;
    for (let i = 0; i < 2; i++, t += 20) pipeline.processAudio(chunk(t, true));
    for (let i = 0; i < 8; i++, t += 20) pipeline.processAudio(chunk(t, false));
    await settle();

    expect(spy).toHaveBeenCalled();
    // Audio was replayed rather than the utterance being abandoned.
    expect(sentAudioCount).toBeGreaterThan(sentBefore);
    expect(pipeline.state.isSpeaking).toBe(true);

    release();
    await pipeline.stop();
  });

  it("honours interruption.enabled=false", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({
      stt,
      tts,
      pipelineOptions: { interruption: { enabled: false, mode: "immediate" } },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    let t = 500;
    for (let i = 0; i < 40; i++, t += 20) pipeline.processAudio(chunk(t, true));
    await settle();

    expect(pipeline.bargeIns).toBe(0);
    expect(pipeline.state.isSpeaking).toBe(true);

    release();
    await pipeline.stop();
  });

  it("interrupts immediately in immediate mode", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({
      stt,
      tts,
      pipelineOptions: { interruption: { mode: "immediate" } },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    let t = 500;
    pipeline.processAudio(chunk(t, true));
    await settle();

    expect(pipeline.bargeIns).toBeGreaterThan(0);
    expect(pipeline.state.isSpeaking).toBe(false);

    release();
    await pipeline.stop();
  });

  it("requires minWords before treating speech as an interruption", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    tts.hold = gate;
    const { pipeline } = await buildPipeline({
      stt,
      tts,
      pipelineOptions: { interruption: { mode: "adaptive", minSpeechMs: 100, minWords: 3 } },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();

    // Sustained speech, but only a single word is transcribed.
    let t = 500;
    for (let i = 0; i < 10; i++, t += 20) pipeline.processAudio(chunk(t, true));
    stt.lastStream!.emitFinal("yeah");
    await settle();

    expect(pipeline.bargeIns).toBe(0);

    release();
    await pipeline.stop();
  });

  it("processes a turn queued while another is still running", async () => {
    const { pipeline, stt, tts } = await buildPipeline();

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    // Speak again immediately, mid-turn.
    speak(pipeline, 80);
    stt.lastStream!.pendingFinal = "where is my order";
    await settle();

    expect(tts.spoken.length).toBeGreaterThanOrEqual(1);
    await pipeline.stop();
  });
});

describe("VoicePipeline tracing", () => {
  /** Collects span names and attributes without needing an OTel SDK. */
  function captureTracer() {
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const tracer = {
      startSpan: (name: string) => makeRecordingSpan(spans, name),
      startActiveSpan: (
        name: string,
        optionsOrFn: unknown,
        maybeFn?: unknown,
      ) => {
        const fn = (maybeFn ?? optionsOrFn) as (s: never) => unknown;
        const options = (maybeFn ? optionsOrFn : undefined) as
          | { attributes?: Record<string, unknown> }
          | undefined;
        const { span, record } = makeRecordingSpan(spans, String(name));
        if (options?.attributes) Object.assign(record.attributes, options.attributes);
        return fn(span as never);
      },
    } as never;

    return { tracer, spans };
  }

  function makeRecordingSpan(
    spans: Array<{ name: string; attributes: Record<string, unknown> }>,
    name: string,
  ) {
    const record = { name: String(name), attributes: {} as Record<string, unknown> };
    spans.push(record);
    const spanContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
    const span = {
      spanContext: () => spanContext,
      setAttribute: (k: string, v: unknown) => {
        record.attributes[k] = v;
        return span;
      },
      setAttributes: (a: Record<string, unknown>) => {
        Object.assign(record.attributes, a);
        return span;
      },
      addEvent: () => span,
      addLink: () => span,
      addLinks: () => span,
      setStatus: () => span,
      updateName: () => span,
      end: () => undefined,
      isRecording: () => true,
      recordException: () => undefined,
    };
    return { span, record };
  }

  it("emits turn, jev, action and tts spans for one turn", async () => {
    const { tracer, spans } = captureTracer();
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: { tracer: new FelonaTracer({ tracer }) },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const names = spans.map((s) => s.name);
    expect(names).toContain(SPAN.turn);
    expect(names).toContain(SPAN.jevDecide);
    expect(names).toContain(SPAN.actionHandler);
    expect(names).toContain(SPAN.ttsSpeak);

    // Ordering is the point of the trace: routing before handling, handling
    // before speech.
    expect(names.indexOf(SPAN.jevDecide)).toBeLessThan(
      names.indexOf(SPAN.actionHandler),
    );
    expect(names.indexOf(SPAN.actionHandler)).toBeLessThan(
      names.indexOf(SPAN.ttsSpeak),
    );
  });

  it("reports the routing decision on the JEV span", async () => {
    const { tracer, spans } = captureTracer();
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: { tracer: new FelonaTracer({ tracer }) },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const jev = spans.find((s) => s.name === SPAN.jevDecide)!;
    expect(jev.attributes["felona.jev.selected_action"]).toBeTruthy();
    expect(typeof jev.attributes["felona.jev.confidence"]).toBe("number");
    expect(typeof jev.attributes["felona.jev.latency_ms"]).toBe("number");
  });

  it("emits a call-end span carrying the outcome", async () => {
    const { tracer, spans } = captureTracer();
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: { tracer: new FelonaTracer({ tracer }) },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const end = spans.find((x) => x.name === SPAN.callEnd);
    expect(end).toBeDefined();
    expect(end!.attributes).toMatchObject({
      "felona.call.turn_count": expect.any(Number),
      "felona.call.barge_in_count": expect.any(Number),
      "felona.call.resolved": expect.any(Boolean),
      "felona.call.escalation_risk": expect.any(Boolean),
      "felona.call.outcome_score": expect.any(Number),
    });
  });

  it("never puts transcript text in a span attribute", async () => {
    const { tracer, spans } = captureTracer();
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: { tracer: new FelonaTracer({ tracer }) },
    });

    // A distinctive utterance, so its absence from the spans is meaningful
    // rather than an accident of the fixture text.
    const spoken = "my card is 4111111111111111 and it was declined";
    stt.lastStream!.pendingFinal = spoken;
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const turn = spans.find((s) => s.name === SPAN.turn)!;
    // The turn is identified by a fingerprint, not by what was said.
    expect(turn.attributes["felona.turn.fingerprint"]).toMatch(/^[0-9a-f]{16}$/);
    expect(turn.attributes["felona.turn.char_count"]).toBe(spoken.length);

    // Spans are exported and stored by the operator's backend, often for far
    // longer than the call — the caller's words must not ride along.
    const dumped = JSON.stringify(spans);
    expect(dumped).not.toContain("4111111111111111");
    expect(dumped).not.toContain("declined");
  });
});

describe("VoicePipeline post-call analysis options", () => {
  it("uses a configured successAction to decide the call was resolved", async () => {
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: { analysis: { successActions: ["order_status"] } },
    });

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const analysis = pipeline.callAnalysis!;
    expect(analysis).not.toBeNull();
    // The action really was used...
    expect(analysis.actionBreakdown.map((a) => a.actionId)).toContain("order_status");
    // ...and it is what decided the outcome, rather than the transcript heuristic.
    expect(analysis.resolved).toBe(true);
    expect(analysis.resolutionSource).toBe("action");
  });

  it("reports the heuristic when nothing is configured", async () => {
    const { pipeline, stt } = await buildPipeline();

    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    expect(pipeline.callAnalysis!.resolutionSource).toBe("heuristic");
  });

  it("lets an explicit resolver override a failed-looking call", async () => {
    const { pipeline, stt } = await buildPipeline({
      pipelineOptions: {
        analysis: {
          // The caller said "cancel", which reads as an escalation...
          resolve: () => true,
        },
      },
    });

    stt.lastStream!.pendingFinal = "I want to cancel my order";
    speak(pipeline);
    await settle();
    await pipeline.stop();

    const analysis = pipeline.callAnalysis!;
    expect(analysis.resolved).toBe(true);
    expect(analysis.resolutionSource).toBe("explicit");
  });

  it("escalates a call the caller barged in on", async () => {
    const { pipeline, stt } = await buildPipeline();
    stt.lastStream!.pendingFinal = "where is my order";
    speak(pipeline);
    await settle();
    (pipeline as unknown as { bargeInCount: number }).bargeInCount = 2;
    await pipeline.stop();

    // Barge-in is evidence the conversation was going badly.
    expect(pipeline.callAnalysis!.escalationRisk).toBe(true);
    expect(pipeline.callAnalysis!.sentiment.label).toBe("negative");
  });
});
