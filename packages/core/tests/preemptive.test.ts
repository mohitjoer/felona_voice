import { describe, it, expect, vi } from "vitest";
import { VoicePipeline } from "../src/pipeline.js";
import { JEVEngine } from "../src/jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../src/jev/fast-embeddings.js";
import { ConversationMemory } from "../src/memory/context.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CallLogger } from "../src/analytics/logger.js";
import { EnergyVAD } from "../src/vad/energy.js";
import type {
  AgentAction,
  AudioChunk,
  Session,
  STTProvider,
  STTResult,
  STTStream,
  TTSProvider,
} from "../src/types.js";

function chunk(timestampMs: number, loud: boolean, ms = 20): AudioChunk {
  const samples = (16000 * ms) / 1000;
  const data = Buffer.alloc(samples * 2);
  if (loud) {
    for (let i = 0; i < samples; i++) {
      data.writeInt16LE(
        Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
        i * 2,
      );
    }
  }
  return { data, sampleRate: 16000, channels: 1, bitDepth: 16, timestampMs };
}

/** Mock STT that emits finals only when the pipeline's flush() runs. */
class DeferredSTTStream implements STTStream {
  private resultHandler: ((r: STTResult) => void) | null = null;
  pendingFinal = "";
  flushCalls = 0;
  closed = false;

  write(): void {}
  onResult(h: (r: STTResult) => void): void {
    this.resultHandler = h;
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
  emitFinal(text: string): void {
    this.resultHandler?.({ text, isFinal: true, confidence: 0.9 });
  }
}

class MockSTT implements STTProvider {
  readonly name = "mock";
  lastStream!: DeferredSTTStream;
  createStream(): STTStream {
    this.lastStream = new DeferredSTTStream();
    return this.lastStream;
  }
}

class MockTTS implements TTSProvider {
  readonly name = "mock";
  spoken: string[] = [];
  async *synthesize(text: string): AsyncIterable<AudioChunk> {
    this.spoken.push(text);
    yield chunk(0, true);
  }
}

const actions: AgentAction[] = [
  {
    id: "order_status",
    description: "Check delivery status and tracking for an order",
    handler: async () => "Your order is out for delivery today.",
  },
  {
    id: "refund_request",
    description: "Process a product return, refund or billing dispute",
    handler: async () => "Your refund has been initiated.",
  },
  {
    id: "fallback",
    description: "Unrecognized or off-topic requests",
    handler: async () => "Sorry, I did not catch that.",
  },
];

async function build(overrides: {
  handlerDelayMs?: number;
  pipelineOptions?: Partial<ConstructorParameters<typeof VoicePipeline>[0]>;
} = {}) {
  const stt = new MockSTT();
  const tts = new MockTTS();
  const jev = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
  await jev.initialize(actions);

  const onUserSpoke = vi.fn();
  const onAgentSpoke = vi.fn();

  const session: Session = { id: "s1", startedAt: new Date(), metadata: {}, state: "active" };
  const memory = new ConversationMemory();

  if (overrides.handlerDelayMs) {
    // Slow handler, so a preemptive attempt is genuinely in flight when the
    // turn closes.
    const original = actions[0].handler;
    actions[0].handler = async (ctx) => {
      await new Promise((r) => setTimeout(r, overrides.handlerDelayMs));
      return original(ctx);
    };
  }

  const pipeline = new VoicePipeline({
    sessionId: "s1",
    session,
    stt,
    tts,
    vad: new EnergyVAD({ hangoverMs: 60, minSpeechMs: 10 }),
    jev,
    memory,
    tools: new ToolRegistry(),
    logger: new CallLogger(),
    hooks: { onUserSpoke, onAgentSpoke } as never,
    systemPrompt: "test",
    sttFlushTimeoutMs: 200,
    sendAudio: async () => {},
    ...overrides.pipelineOptions,
  });

  await pipeline.start();
  return { pipeline, stt, tts, memory, onUserSpoke, onAgentSpoke };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function speak(pipeline: VoicePipeline, loudForMs = 100): void {
  let t = 0;
  for (; t < loudForMs; t += 20) pipeline.processAudio(chunk(t, true));
  for (let i = 0; i < 10; i++, t += 20) pipeline.processAudio(chunk(t, false));
}

describe("preemptive generation", () => {
  it("records a turn exactly once when the transcript is stable", async () => {
    const { pipeline, stt, memory, onUserSpoke, onAgentSpoke } = await build();

    stt.lastStream.pendingFinal = "where is my order";
    speak(pipeline);
    await settle(400);

    const userTurns = memory.getTurns().filter((t) => t.role === "user");
    const agentTurns = memory.getTurns().filter((t) => t.role === "agent");

    // The bug this guards: a preemptive run plus a confirmed run recording the
    // same conversation twice.
    expect(userTurns).toHaveLength(1);
    expect(agentTurns).toHaveLength(1);
    expect(onUserSpoke).toHaveBeenCalledTimes(1);
    expect(onAgentSpoke).toHaveBeenCalledTimes(1);

    await pipeline.stop();
  });

  it("does not double-record when the transcript mutates mid-turn", async () => {
    const { pipeline, stt, memory, onUserSpoke } = await build({ handlerDelayMs: 60 });

    // Speech, then a first final that will be superseded.
    let t = 0;
    for (; t < 100; t += 20) pipeline.processAudio(chunk(t, true));
    stt.lastStream.emitFinal("where is my");
    await settle(30);

    for (let i = 0; i < 10; i++, t += 20) pipeline.processAudio(chunk(t, false));
    stt.lastStream.pendingFinal = "where is my order";
    await settle(400);

    const userTurns = memory.getTurns().filter((t) => t.role === "user");
    const agentTurns = memory.getTurns().filter((t) => t.role === "agent");

    expect(userTurns).toHaveLength(1);
    expect(agentTurns).toHaveLength(1);
    // The final text is what gets recorded, not the abandoned partial.
    expect(userTurns[0].content).toBe("where is my order");
    expect(onUserSpoke).toHaveBeenCalledTimes(1);

    await pipeline.stop();
  });

  it("reuses a matching preemptive plan instead of re-running the handler", async () => {
    let calls = 0;
    const original = actions[0].handler;
    actions[0].handler = async (ctx) => {
      calls++;
      return original(ctx);
    };

    const { pipeline, stt } = await build();
    stt.lastStream.pendingFinal = "where is my order";
    speak(pipeline);
    await settle(400);

    // Exactly one handler invocation: the preemptive plan was adopted rather
    // than recomputed.
    expect(calls).toBe(1);

    actions[0].handler = original;
    await pipeline.stop();
  });

  it("does not preempt when disabled", async () => {
    const { pipeline, stt, memory } = await build({
      pipelineOptions: { preemptive: { enabled: false } },
    });

    stt.lastStream.pendingFinal = "where is my order";
    speak(pipeline);
    await settle(400);

    expect(memory.getTurns()).toHaveLength(2);
    await pipeline.stop();
  });

  it("still answers correctly when a preemptive attempt fails", async () => {
    const { pipeline, stt, tts } = await build({ handlerDelayMs: 80 });

    stt.lastStream.pendingFinal = "where is my order";
    speak(pipeline);
    await settle(500);

    expect(tts.spoken.length).toBeGreaterThan(0);
    await pipeline.stop();
  });
});
