import { describe, it, expect } from "vitest";
import {
  chunkText,
  chunkDocument,
  splitSentences,
} from "../src/knowledge/chunk.js";
import { KnowledgeBase, createKnowledgeBase } from "../src/knowledge/kb.js";
import { createKnowledgeTask, defaultKnowledgeAnswer } from "../src/knowledge/task.js";
import { FastSemanticEmbeddingProvider } from "../src/jev/fast-embeddings.js";
import { ConversationMemory } from "../src/memory/context.js";
import type { ActionContext } from "../src/types.js";

const provider = () => new FastSemanticEmbeddingProvider();

describe("sentence splitting", () => {
  it("splits on sentence boundaries", () => {
    const sentences = splitSentences("First one. Second one! Third one?");
    expect(sentences).toEqual(["First one.", "Second one!", "Third one?"]);
  });

  it("does not split on common abbreviations", () => {
    const sentences = splitSentences("Call Dr. Smith at 3 p.m. tomorrow.");
    expect(sentences.length).toBeLessThanOrEqual(2);
  });

  it("keeps a decimal number intact", () => {
    expect(splitSentences("The fee is 4.5 dollars. That is all.").length).toBe(2);
  });
});

describe("chunking", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short document as one chunk", () => {
    const chunks = chunkText("Our returns policy allows 30 days.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("30 days");
  });

  it("splits a long document near the target size", () => {
    const paragraph = "This is a sentence about our policy. ".repeat(40);
    const chunks = chunkText(paragraph, { targetChars: 300, maxChars: 600 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Overlap can push a chunk past maxChars by up to overlapChars.
      expect(chunk.text.length).toBeLessThanOrEqual(600 + 100);
    }
  });

  it("overlaps consecutive chunks so boundary facts stay retrievable", () => {
    const paragraph = "Shipping takes three business days. ".repeat(40);
    const chunks = chunkText(paragraph, {
      targetChars: 300,
      maxChars: 600,
      overlapChars: 80,
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Text from the end of chunk N is carried into chunk N+1. (The overlap is
    // snapped to a word boundary, so compare a window rather than the exact
    // tail slice.)
    expect(chunks[1].text).toContain(chunks[0].text.slice(-40));
    // ...which is why the overlapped chunk is longer than its own body.
    expect(chunks[1].text.length).toBeGreaterThan(300);
  });

  it("never splits mid-word", () => {
    const text = "a".repeat(50) + " " + "b".repeat(50) + " " + "c".repeat(50);
    const chunks = chunkText(text, { targetChars: 60, maxChars: 80, minChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/[a-z] [a-z]/);
    }
  });

  it("hard-splits a single unbreakable run of characters", () => {
    const chunks = chunkText("x".repeat(500), { targetChars: 100, maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
  });

  it("prefixes ids with the source", () => {
    const chunks = chunkDocument("Some policy text here.", "returns");
    expect(chunks[0].id.startsWith("returns::")).toBe(true);
    expect(chunks[0].sourceId).toBe("returns");
  });
});

describe("KnowledgeBase", () => {
  const policies = [
    {
      id: "returns",
      text: "Returns are accepted within 30 days of delivery. Items must be unused and in original packaging. Refunds are issued to the original payment method within 5 business days.",
      metadata: { topic: "returns" },
    },
    {
      id: "shipping",
      text: "Standard shipping takes three to five business days. Express shipping is next business day. We ship to all 50 US states but not to PO boxes.",
      metadata: { topic: "shipping" },
    },
    {
      id: "hours",
      text: "Support is open Monday to Friday, 9am to 6pm Eastern. Weekend support is available by email only.",
      metadata: { topic: "hours" },
    },
  ];

  const build = async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    await kb.addAll(policies);
    return kb;
  };

  it("requires an embedding provider", () => {
    expect(() => createKnowledgeBase({} as never)).toThrow(/embeddingProvider/);
  });

  it("rejects documents with no id or text", async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    await expect(kb.add({ id: "", text: "x" })).rejects.toThrow(/id/);
    await expect(kb.add({ id: "a", text: "  " })).rejects.toThrow(/no text/);
  });

  it("indexes documents and chunks", async () => {
    const kb = await build();
    expect(kb.documentCount).toBe(3);
    expect(kb.size).toBeGreaterThanOrEqual(3);
    expect(kb.listDocuments()).toEqual(["returns", "shipping", "hours"]);
  });

  it("retrieves the relevant policy", async () => {
    const kb = await build();

    const results = await kb.search("how long do I have to return something");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sourceId).toBe("returns");

    const shipping = await kb.search("how long does express shipping take");
    expect(shipping[0].sourceId).toBe("shipping");
  });

  it("returns nothing when the query is unrelated", async () => {
    const kb = await build();
    // The min-score floor is what stops a confident answer from the least-bad
    // paragraph the base happens to own.
    const results = await kb.search("quantum chromodynamics lattice simulation", {
      minScore: 0.4,
    });
    expect(results).toEqual([]);
  });

  it("honours topK", async () => {
    const kb = await build();
    const results = await kb.search("policy", { topK: 1, minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("filters by metadata", async () => {
    const kb = await build();

    const onlyReturns = await kb.search("policy", {
      filter: { topic: "returns" },
      minScore: 0,
    });
    expect(onlyReturns.every((r) => r.sourceId === "returns")).toBe(true);

    const none = await kb.search("policy", { filter: { topic: "nonexistent" } });
    expect(none).toEqual([]);
  });

  it("replaces a document rather than duplicating it", async () => {
    const kb = await build();
    const before = kb.size;

    await kb.add({
      id: "returns",
      text: "Returns are accepted within 90 days of delivery, extended for the holiday season.",
      metadata: { topic: "returns" },
    });

    // A stale duplicate of an updated policy is how a knowledge base starts
    // contradicting itself.
    expect(kb.size).toBeLessThan(before + 5);

    // Scope to the replaced document: with minScore 0 every document matches.
    const results = await kb.search("how many days for a return", {
      minScore: 0,
      filter: { topic: "returns" },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.text.includes("90 days"))).toBe(true);
    expect(results.some((r) => r.text.includes("30 days"))).toBe(false);
  });

  it("removes and clears", async () => {
    const kb = await build();

    expect(kb.remove("returns")).toBe(true);
    expect(kb.documentCount).toBe(2);

    const results = await kb.search("returns policy", { minScore: 0 });
    expect(results.every((r) => r.sourceId !== "returns")).toBe(true);

    kb.clear();
    expect(kb.size).toBe(0);
    expect(kb.documentCount).toBe(0);
  });

  it("returns nothing when empty or given an empty query", async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    expect(await kb.search("anything")).toEqual([]);
    await kb.addAll(policies);
    expect(await kb.search("   ")).toEqual([]);
  });

  it("caches repeated queries", async () => {
    let calls = 0;
    const counting = {
      name: "counting",
      dimensions: 4,
      embed: async (t: string) => {
        calls++;
        return new Float64Array([t.length % 7, 1, 0, 0]);
      },
      embedBatch: async (texts: string[]) => Promise.all(texts.map((t) => counting.embed(t))),
    };

    const kb = createKnowledgeBase({ embeddingProvider: counting });
    await kb.add({ id: "a", text: "Some content about widgets and gadgets." });

    const after = calls;
    await kb.search("widgets");
    await kb.search("widgets");

    // The query is embedded once, not once per search.
    expect(calls).toBe(after + 1);
  });

  it("formats results with their source for citation", async () => {
    const kb = await build();
    const results = await kb.search("returns policy");
    const text = KnowledgeBase.formatContext(results);

    expect(text).toContain("returns");
    expect(text).toContain("score");
  });
});

describe("knowledge task", () => {
  const ctx = (utterance: string): ActionContext => ({
    conversation: {
      session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
      turns: [],
      currentUtterance: utterance,
      slots: {},
      systemPrompt: "",
    },
    tools: { call: async () => undefined, list: () => [] },
    memory: new ConversationMemory(),
    session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
  });

  it("requires an answer function rather than composing one", () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    expect(() => createKnowledgeTask({ knowledge: kb } as never)).toThrow(/answer/);
    expect(() => createKnowledgeTask({ answer: () => "" } as never)).toThrow(/knowledge base/);
  });

  it("passes retrieved passages to the answer function", async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    await kb.add({ id: "returns", text: "Returns are accepted within 30 days of delivery." });

    const task = createKnowledgeTask({
      knowledge: kb,
      answer: (results) =>
        results.length > 0 ? results[0].text : "I don't know that one.",
    });

    const reply = await task.handler(ctx("how long do I have to return an item?"));
    expect(reply).toContain("30 days");
  });

  it("tells the caller when nothing was found", async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    await kb.add({ id: "returns", text: "Returns are accepted within 30 days of delivery." });

    const task = createKnowledgeTask({
      knowledge: kb,
      search: { minScore: 0.9 },
      answer: defaultKnowledgeAnswer,
    });

    const reply = await task.handler(ctx("unrelated question about nothing"));
    expect(reply).toContain("don't have that information");
  });

  it("stores passages when asked", async () => {
    const kb = createKnowledgeBase({ embeddingProvider: provider() });
    await kb.add({ id: "hours", text: "Support is open Monday to Friday 9am to 6pm Eastern." });

    const task = createKnowledgeTask({
      knowledge: kb,
      storeUnder: "kb_passages",
      answer: (results) => `found ${results.length}`,
    });

    const context = ctx("what are your support hours");
    await task.handler(context);

    const stored = context.memory.getSlot("kb_passages");
    expect(Array.isArray(stored)).toBe(true);
  });
});

describe("knowledge through the agent", () => {
  it("routes a factual question to the knowledge base and answers from it", async () => {
    const { createAgent } = await import("../src/builder.js");

    const builder = createAgent("Acme Support")
      .system("You answer policy questions from the knowledge base.")
      .action("greet", "Greet the caller", "Hello, how can I help?")
      .knowledgeTask({
        id: "policy",
        description:
          "Answer questions about the company return policy, shipping times, " +
          "and support hours using the knowledge base.",
        answer: (results) =>
          results.length > 0
            ? results[0].text
            : "I don't have that information in front of me right now.",
      })
      .fallback("Sorry, could you rephrase that?");

    const agent = builder.build();

    await agent.knowledge.add({
      id: "returns",
      text: "Returns are accepted within 30 days of delivery, provided the item is unused and in its original packaging.",
    });

    const reply = await agent.interact("what is your return policy and how long do I have");

    expect(reply.action.id).toBe("policy");
    expect(reply.text).toContain("30 days");
  });

  it("admits ignorance rather than answering from the least-relevant passage", async () => {
    const { createAgent } = await import("../src/builder.js");

    const agent = createAgent("Acme Support")
      // A permissive routing threshold so the turn reaches the knowledge
      // action; the retrieval threshold below is what must reject the answer.
      .threshold(0.1)
      .knowledgeTask({
        id: "policy",
        description:
          "Answer questions about company policy, returns, shipping and support " +
          "hours using the knowledge base.",
        search: { minScore: 0.6 },
        answer: (results) =>
          results.length > 0 ? results[0].text : "I don't have that information.",
      })
      .build();

    // The base deliberately knows nothing about returns, so the query routes
    // confidently to the knowledge action but retrieves nothing — the case
    // where a permissive retrieval threshold would answer from the nearest
    // irrelevant passage instead of admitting ignorance.
    await agent.knowledge.add({
      id: "hours",
      text: "Office hours are 9am to 5pm on weekdays. The support desk is staffed by four people.",
    });

    const reply = await agent.interact("what is your returns policy");

    expect(reply.action.id).toBe("policy");
    expect(reply.text).toContain("don't have that information");
  });
});
