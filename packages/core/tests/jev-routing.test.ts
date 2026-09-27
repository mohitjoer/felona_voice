import { describe, it, expect } from "vitest";
import { JEVEngine } from "../src/jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../src/jev/fast-embeddings.js";
import { EnergyVAD } from "../src/vad/energy.js";
import type { AgentAction, AudioChunk, Session } from "../src/types.js";

const engineFor = async (actions: AgentAction[], threshold?: number) => {
  const engine = new JEVEngine({
    embeddingProvider: new FastSemanticEmbeddingProvider(),
    confidenceThreshold: threshold,
  });
  await engine.initialize(actions);
  return engine;
};

const actions: AgentAction[] = [
  { id: "greet", description: "Greet the user warmly and welcome them", handler: async () => "" },
  { id: "order_status", description: "Check delivery status, tracking number and carrier ETA for an order", handler: async () => "" },
  { id: "refund_request", description: "Process a product return, refund, billing dispute or return shipping label", handler: async () => "" },
  { id: "escalate", description: "Escalate the call to a human supervisor or manager", handler: async () => "" },
  { id: "fallback", description: "Unrecognized queries, background noise or off-topic requests", handler: async () => "" },
];

const context = (text: string) => ({
  session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" } as Session,
  turns: [],
  currentUtterance: text,
  slots: {},
  systemPrompt: "",
});

describe("ActionSpace validation", () => {
  it("rejects duplicate action ids", async () => {
    const engine = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await expect(
      engine.initialize([
        { id: "dup", description: "First", handler: async () => "" },
        { id: "dup", description: "Second", handler: async () => "" },
      ]),
    ).rejects.toThrow(/Duplicate action id/);
  });

  it("rejects an empty action list", async () => {
    const engine = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await expect(engine.initialize([])).rejects.toThrow(/at least one action/);
  });

  it("rejects an action with no description", async () => {
    const engine = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await expect(
      engine.initialize([{ id: "a", description: "   ", handler: async () => "" }]),
    ).rejects.toThrow(/description/);
  });

  it("does not retain embeddings for removed actions on re-initialize", async () => {
    const engine = await engineFor(actions);
    expect(engine.getActionSpace().getEmbedding("greet")).toBeDefined();

    // "escalate" is dropped from the new action set.
    await engine.initialize(actions.slice(0, 2));
    expect(engine.getActionSpace().getEmbedding("escalate")).toBeUndefined();
    expect(engine.getActionSpace().getEmbedding("greet")).toBeDefined();
  });
});

describe("JEVEngine predictor", () => {
  it("rejects a configured predictor model instead of silently degrading", async () => {
    const engine = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await expect(engine.loadPredictor("/tmp/model.onnx")).rejects.toThrow(/not supported/);
  });

  it("passes the context vector through in cold-start mode", async () => {
    const engine = await engineFor(actions);
    const vec = await engine.encode(context("where is my order"));
    const predicted = await engine.predict(vec);
    expect(Array.from(predicted)).toEqual(Array.from(vec));
    expect(engine.hasPredictor).toBe(false);
  });
});

describe("FastSemanticEmbeddingProvider routing", () => {
  it("routes inflected and verbose utterances to the right action", async () => {
    const engine = await engineFor(actions);
    const cases: Array<[string, string]> = [
      ["where is my order", "order_status"],
      ["i need to track my package please", "order_status"],
      ["can I return this and get my money back", "refund_request"],
      ["billing charged my card twice and i dispute it", "refund_request"],
      ["let me speak to a manager please", "escalate"],
      ["what is the weather in paris", "fallback"],
    ];

    for (const [text, expected] of cases) {
      const match = await engine.decide(context(text));
      expect(match.action.id, `"${text}"`).toBe(expected);
    }
  });

  it("is not dominated by character-gram noise on long utterances", async () => {
    const engine = await engineFor(actions);

    // Padding with irrelevant words used to bury the keyword signal under
    // accumulated 3-gram counts and collapse routing to `fallback`.
    const short = await engine.decide(context("i want a refund"));
    const padded = await engine.decide(
      context(
        "so anyway i was thinking about it and i decided that i want a refund " +
          "because well actually it is quite complicated to explain but anyway",
      ),
    );

    expect(short.action.id).toBe("refund_request");
    expect(padded.action.id).toBe("refund_request");
  });

  it("stays stable for the same input", async () => {
    const provider = new FastSemanticEmbeddingProvider();
    const a = await provider.embed("check my order status");
    const b = await provider.embed("check my order status");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("handles empty and stopword-only input without NaN", async () => {
    const provider = new FastSemanticEmbeddingProvider();
    for (const text of ["", "   ", "the and of it"]) {
      const vec = await provider.embed(text);
      expect(vec.length).toBe(provider.dimensions);
      for (const value of vec) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("EnergyVAD validation", () => {
  it("rejects a silence threshold that would never end speech", () => {
    expect(() => new EnergyVAD({ speechThreshold: 0.01, silenceThreshold: 0.02 })).toThrow(
      /must be lower than/,
    );
  });

  it("rejects non-positive and non-finite thresholds", () => {
    expect(() => new EnergyVAD({ speechThreshold: 0 })).toThrow(/positive finite/);
    expect(() => new EnergyVAD({ silenceThreshold: Number.NaN })).toThrow(/positive finite/);
    expect(() => new EnergyVAD({ hangoverMs: -1 })).toThrow(/non-negative/);
  });

  it("accepts the documented defaults", () => {
    expect(() => new EnergyVAD()).not.toThrow();
  });
});

describe("EnergyVAD turn boundaries", () => {
  const loud = (t: number): AudioChunk => {
    const data = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
    }
    return { data, sampleRate: 16000, channels: 1, bitDepth: 16, timestampMs: t };
  };
  const silent = (t: number): AudioChunk => ({
    data: Buffer.alloc(640),
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    timestampMs: t,
  });

  it("emits speech_start once and speech_end after the hangover", () => {
    const vad = new EnergyVAD({ hangoverMs: 100, minSpeechMs: 10 });

    const events: string[] = [];
    for (let t = 0; t <= 400; t += 20) {
      const chunk = t < 100 ? loud(t) : silent(t);
      const result = vad.process(chunk);
      if (result.event) events.push(result.event.type);
    }

    expect(events.filter((e) => e === "speech_start")).toHaveLength(1);
    expect(events.filter((e) => e === "speech_end")).toHaveLength(1);
  });
});
