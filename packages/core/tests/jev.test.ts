import { describe, it, expect } from "vitest";
import { cosineSimilarity, ActionSpace } from "../src/jev/action-space.js";
import type { EmbeddingProvider, AgentAction } from "../src/types.js";

// ─── Mock Embedding Provider ───────────────────────────────────────────────

/**
 * Mock embedding provider that returns deterministic vectors
 * for testing action matching. Each word maps to a known direction.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly dimensions = 4;

  private readonly wordVectors: Record<string, number[]> = {
    greet: [1, 0, 0, 0],
    hello: [0.9, 0.1, 0, 0],
    help: [0, 1, 0, 0],
    question: [0.1, 0.9, 0, 0],
    goodbye: [0, 0, 1, 0],
    bye: [0.1, 0, 0.9, 0],
    escalate: [0, 0, 0, 1],
    angry: [0.1, 0, 0, 0.8],
  };

  async embed(text: string): Promise<Float64Array> {
    // Find the best matching word in the text
    const words = text.toLowerCase().split(/\s+/);
    let bestVector = [0.25, 0.25, 0.25, 0.25]; // default = uniform

    for (const word of words) {
      if (this.wordVectors[word]) {
        bestVector = this.wordVectors[word];
        break;
      }
    }

    return new Float64Array(bestVector);
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ─── Test Actions ───────────────────────────────────────────────────────────

const testActions: AgentAction[] = [
  {
    id: "greet",
    description: "Greet the user warmly",
    handler: async () => "Hello!",
  },
  {
    id: "help",
    description: "Help the user with their question",
    handler: async () => "Let me help you.",
  },
  {
    id: "goodbye",
    description: "Say goodbye to the user",
    handler: async () => "Goodbye!",
  },
  {
    id: "escalate",
    description: "Escalate to a human agent",
    handler: async () => "Transferring you now.",
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float64Array([1, 0, 0]);
    const b = new Float64Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float64Array([1, 0, 0]);
    const b = new Float64Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float64Array([1, 0, 0]);
    const b = new Float64Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("handles similar but not identical vectors", () => {
    const a = new Float64Array([1, 0.1, 0]);
    const b = new Float64Array([0.9, 0.2, 0]);
    const similarity = cosineSimilarity(a, b);
    expect(similarity).toBeGreaterThan(0.9);
    expect(similarity).toBeLessThan(1.0);
  });

  it("throws on dimension mismatch", () => {
    const a = new Float64Array([1, 0]);
    const b = new Float64Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("dimension mismatch");
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float64Array([0, 0, 0]);
    const b = new Float64Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("ActionSpace", () => {
  it("initializes and embeds all actions", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    expect(space.size).toBe(4);
    expect(space.getAction("greet")).toBeDefined();
    expect(space.getAction("nonexistent")).toBeUndefined();
  });

  it("matches a 'hello' vector to the greet action", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    // "hello" → [0.9, 0.1, 0, 0] should be closest to "greet" → [1, 0, 0, 0]
    const helloVector = await provider.embed("hello");
    const match = space.match(helloVector);

    expect(match.action.id).toBe("greet");
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("matches a 'question' vector to the help action", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    const questionVector = await provider.embed("question");
    const match = space.match(questionVector);

    expect(match.action.id).toBe("help");
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it("matches 'bye' to goodbye action", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    const byeVector = await provider.embed("bye");
    const match = space.match(byeVector);

    expect(match.action.id).toBe("goodbye");
  });

  it("matches 'angry' to escalate action", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    const angryVector = await provider.embed("angry");
    const match = space.match(angryVector);

    expect(match.action.id).toBe("escalate");
  });

  it("returns all candidates sorted by score", async () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);
    await space.initialize(testActions);

    const helloVector = await provider.embed("hello");
    const match = space.match(helloVector);

    expect(match.candidates.length).toBe(4);
    // First candidate should be the best match
    expect(match.candidates[0].actionId).toBe(match.action.id);
    // Candidates should be sorted descending
    for (let i = 1; i < match.candidates.length; i++) {
      expect(match.candidates[i - 1].score).toBeGreaterThanOrEqual(
        match.candidates[i].score,
      );
    }
  });

  it("throws if match called before initialize", () => {
    const provider = new MockEmbeddingProvider();
    const space = new ActionSpace(provider);

    expect(() => space.match(new Float64Array([1, 0, 0, 0]))).toThrow(
      "not initialized",
    );
  });
});
