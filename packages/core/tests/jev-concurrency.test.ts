import { describe, it, expect, vi } from "vitest";
import { ActionSpace } from "../src/jev/action-space.js";
import { AgentBuilder } from "../src/builder.js";
import type { AgentAction, EmbeddingProvider } from "../src/types.js";

/**
 * Embedding provider whose `embedBatch` can be held open on demand.
 *
 * `holdAfter` lets the first call through immediately and blocks the next, so
 * a re-initialization can be observed mid-flight.
 */
function makeProvider(gate?: { promise: Promise<void>; holdAfter: number }) {
  let calls = 0;
  return {
    name: "test",
    dimensions: 4,
    async embed(text: string): Promise<Float64Array> {
      return Float64Array.from([text.length, 1, 0, 0]);
    },
    async embedBatch(texts: string[]): Promise<Float64Array[]> {
      calls++;
      if (gate && calls > gate.holdAfter) await gate.promise;
      return texts.map((t) => Float64Array.from([t.length, 1, 0, 0]));
    },
  } as unknown as EmbeddingProvider;
}

function action(id: string, description = `${id} description`): AgentAction {
  return { id, description, handler: async () => "ok" } as unknown as AgentAction;
}

describe("ActionSpace concurrency", () => {
  it("never throws a TypeError when match() races re-initialization", async () => {
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => { release = r; }), holdAfter: 1 };
    const provider = makeProvider(gate);
    const space = new ActionSpace(provider);

    await space.initialize([action("alpha"), action("beta")]);

    // Start a re-initialization and leave it suspended mid-flight.
    const reinit = space.initialize([action("gamma"), action("delta")]);
    // Concurrent routing while the swap is in progress.
    let matchError: unknown;
    try {
      for (let i = 0; i < 20; i++) {
        space.match(Float64Array.from([1, 0, 0, 0]));
      }
    } catch (error) {
      matchError = error;
    }

    release();
    await reinit;

    // The bug was an undefined best match, i.e. `Cannot read ... of undefined`.
    expect(matchError).toBeUndefined();
  });

  it("serves the previous consistent state while re-initializing", async () => {
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => { release = r; }), holdAfter: 1 };
    const space = new ActionSpace(makeProvider(gate));
    await space.initialize([action("alpha")]);

    const reinit = space.initialize([action("omega")]);
    // Old action still routable, not a half-swapped mixture.
    const result = space.match(Float64Array.from([1, 0, 0, 0]));
    expect(result.action.id).toBe("alpha");

    release();
    await reinit;
    expect(space.match(Float64Array.from([1, 0, 0, 0])).action.id).toBe("omega");
  });

  it("throws a clear error when no action has an embedding", async () => {
    const provider = {
      name: "broken",
      async embed(): Promise<Float64Array> { return new Float64Array(4); },
      async embedBatch(): Promise<Float64Array[]> { return []; },
    } as unknown as EmbeddingProvider;
    const space = new ActionSpace(provider);
    await expect(space.initialize([action("a")])).rejects.toThrow(/no vector/);
  });

  it("rejects duplicate and blank action ids", async () => {
    const space = new ActionSpace(makeProvider());
    await expect(space.initialize([action("a"), action("a")])).rejects.toThrow(/Duplicate/);
    await expect(space.initialize([])).rejects.toThrow(/at least one action/);
    await expect(
      space.initialize([{ id: "x", description: "", handler: async () => "" } as unknown as AgentAction]),
    ).rejects.toThrow(/non-empty description/);
  });
});

describe("AgentBuilder rebuild does not duplicate knowledge actions", () => {
  const makeBuilder = () =>
    new AgentBuilder()
      .name("test")
      .stt({ provider: "deepgram", apiKey: "k" })
      .tts({ provider: "deepgram", apiKey: "k" })
      .action("greet", "greet the caller", async () => "hello")
      .knowledgeTask({ id: "kb", documents: [{ content: "some fact", id: "d1" }], answer: (p: { best: { text: string } }) => p.best.text } as never);

  it("keeps exactly one action per id across rebuilds", () => {
    const builder = makeBuilder();
    builder.build();
    // Force a cache miss by adding an action after the first build.
    builder.action("bye", "say goodbye", async () => "bye");
    const agent = builder.build();

    // Inspect the materialised action list directly: the bug was the knowledge
    // task being pushed a second time, producing a duplicate id that JEV
    // rejects at initialize (i.e. a hard failure, not a silent one).
    const ids = (builder as unknown as { actionList: Array<{ id: string }> })
      .actionList.map((a) => a.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
    expect(agent).toBeDefined();
  });

  it("does not accumulate knowledge actions over repeated rebuilds", () => {
    const builder = makeBuilder();
    const readIds = () =>
      (builder as unknown as { actionList: Array<{ id: string }> }).actionList.map(
        (a) => a.id,
      );

    builder.build();
    const first = readIds().filter((id) => id === "kb").length;

    for (let i = 0; i < 3; i++) {
      builder.action(`extra${i}`, `extra action ${i}`, async () => "x");
      builder.build();
    }
    const last = readIds().filter((id) => id === "kb").length;

    // Exactly one knowledge action, no matter how many rebuilds.
    expect(first).toBe(1);
    expect(last).toBe(1);
  });
});

describe("ActionSpace provider call count", () => {
  it("embeds each description once per initialize", async () => {
    const spy = vi.fn(async (texts: string[]) => texts.map((t) => Float64Array.from([t.length, 0, 0, 0])));
    const provider = {
      name: "spy",
      embed: async () => new Float64Array(4),
      embedBatch: spy,
    } as unknown as EmbeddingProvider;
    const space = new ActionSpace(provider);
    await space.initialize([action("a"), action("b")]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(2);
  });
});
