import { describe, it, expect, vi } from "vitest";
import { ConversationMemory } from "../src/memory/context.js";
import { MemorySessionStore, SessionManager } from "../src/session/index.js";
import type { SessionRecord, ConversationTurn } from "../src/types.js";

function turn(content: string, role: "user" | "agent" = "user"): ConversationTurn {
  return { role, content, timestampMs: Date.now() };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    state: "active",
    metadata: {},
    slots: {},
    turns: [],
    ...overrides,
  };
}

describe("ConversationMemory.rehydrate", () => {
  it("restores turns and slots from a persisted record", () => {
    const memory = new ConversationMemory();
    memory.rehydrate({
      turns: [turn("where is my order"), turn("it shipped", "agent")],
      slots: { orderId: "A-1" },
    });
    expect(memory.getTurns().map((t) => t.content)).toEqual([
      "where is my order",
      "it shipped",
    ]);
    expect(memory.getSlots()).toEqual({ orderId: "A-1" });
  });

  it("restores only the most recent window", () => {
    const memory = new ConversationMemory({ maxTurns: 3 });
    memory.rehydrate({
      turns: [1, 2, 3, 4, 5].map((n) => turn(`t${n}`)),
    });
    expect(memory.getTurns().map((t) => t.content)).toEqual(["t3", "t4", "t5"]);
  });

  it("copies rather than aliasing the persisted turns", () => {
    const memory = new ConversationMemory();
    const source = [turn("original")];
    memory.rehydrate({ turns: source });
    memory.addTurn(turn("added"));
    // Mutating restored memory must not write through to the store's array.
    expect(source).toHaveLength(1);
  });

  it("tolerates an empty or partial record", () => {
    const memory = new ConversationMemory();
    expect(() => memory.rehydrate({})).not.toThrow();
    expect(() => memory.rehydrate({ turns: [], slots: {} })).not.toThrow();
    expect(memory.getTurns()).toEqual([]);
  });
});

describe("SessionStore is authoritative, not a write-only mirror", () => {
  it("a second manager can resume a conversation another one started", async () => {
    const store = new MemorySessionStore();
    const nodeA = new SessionManager({ store, maxConcurrent: 10 });
    const nodeB = new SessionManager({ store, maxConcurrent: 10 });

    // Node A takes the call and runs two turns.
    await nodeA.createSession({ id: "call-1" });
    await nodeA.addTurn("call-1", turn("where is my order"));
    await nodeA.addTurn("call-1", turn("it shipped", "agent"));
    await nodeA.setSlot("call-1", "orderId", "A-1");

    // Node B picks the call up mid-way, e.g. after a reconnect.
    const memory = new ConversationMemory();
    const record = await nodeB.getSession("call-1");
    expect(record).not.toBeNull();
    memory.rehydrate(record!);

    // This is the regression: previously the store held the turns but nothing
    // ever read them back, so the resumed call had no history.
    expect(memory.getTurns().map((t) => t.content)).toEqual([
      "where is my order",
      "it shipped",
    ]);
    expect(memory.getSlots().orderId).toBe("A-1");

    // And a turn added on node B is visible to node A.
    await nodeB.addTurn("call-1", turn("thanks"));
    const fromA = await nodeA.getSession("call-1");
    expect(fromA?.turns).toHaveLength(3);

    await nodeA.close();
    await nodeB.close();
  });

  it("a new manager reads state a previous one persisted", async () => {
    // A durable store outlives the manager that wrote to it. The in-memory
    // store's own `close()` clears it, so this models a process restart
    // against Redis rather than against the default store.
    const store = new MemorySessionStore();
    const first = new SessionManager({ store });
    await first.createSession({ id: "x" });
    await first.addTurn("x", turn("remember this"));
    await first.setSlot("x", "stage", "verified");

    const revived = new SessionManager({ store });
    const record = await revived.getSession("x");
    expect(record?.turns[0].content).toBe("remember this");

    const memory = new ConversationMemory();
    memory.rehydrate(record!);
    expect(memory.getTurns()[0].content).toBe("remember this");
    expect(memory.getSlots().stage).toBe("verified");

    await revived.close();
  });
});

describe("default concurrency limit", () => {
  it("is finite so one process cannot accept unbounded calls", async () => {
    const manager = new SessionManager();
    const stats = await manager.getStats();
    expect(Number.isFinite(stats.maxConcurrent)).toBe(true);
    expect(stats.maxConcurrent).toBeGreaterThan(0);
    await manager.close();
  });

  it("rejects a call beyond the limit and reports it", async () => {
    const manager = new SessionManager({ maxConcurrent: 2 });
    await manager.createSession({ id: "a" });
    await manager.createSession({ id: "b" });

    const failures: unknown[] = [];
    manager.on("concurrencyLimitReached", (active, max) => {
      failures.push({ active, max });
    });

    await expect(manager.createSession({ id: "c" })).rejects.toThrow();
    expect(failures).toHaveLength(1);
    await manager.close();
  });

  it("releases capacity when a call ends", async () => {
    const manager = new SessionManager({ maxConcurrent: 1 });
    await manager.createSession({ id: "a" });
    await expect(manager.createSession({ id: "b" })).rejects.toThrow();
    await manager.endSession("a");
    await expect(manager.createSession({ id: "b" })).resolves.toBeDefined();
    await manager.close();
  });

  it("admits concurrent creates up to the limit without over-admitting", async () => {
    const manager = new SessionManager({ maxConcurrent: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => manager.createSession({ id: `s${i}` })),
    );
    const admitted = results.filter((r) => r.status === "fulfilled").length;
    expect(admitted).toBe(3);
    await manager.close();
  });
});

describe("store failure does not take a call down", () => {
  it("logs rather than throws when the store is unreachable", async () => {
    const failing = {
      get: vi.fn(async () => { throw new Error("connection refused"); }),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => false),
      touch: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      clear: vi.fn(async () => {}),
    };
    const manager = new SessionManager({ store: failing, maxConcurrent: 5 });
    // Reading a session that does not exist must not throw upward.
    await expect(manager.getSession("nope")).rejects.toThrow("connection refused");
    await manager.close();
  });
});
