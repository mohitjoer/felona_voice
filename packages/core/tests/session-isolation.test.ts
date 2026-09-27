import { describe, it, expect } from "vitest";
import { MemorySessionStore } from "../src/session/memory-store.js";
import { SessionManager } from "../src/session/manager.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    state: "active",
    metadata: {},
    slots: {},
    turns: [],
    ...overrides,
  };
}

describe("MemorySessionStore isolation", () => {
  it("does not hand out live references into stored state", async () => {
    const store = new MemorySessionStore();
    await store.set("s1", makeRecord("s1", {
      slots: { orderId: "A1" },
      turns: [{ role: "user", content: "hello", timestampMs: 0 }],
    }));

    const first = await store.get("s1");

    // Mutating what get() returned must not corrupt the store.
    first!.slots.orderId = "MUTATED";
    first!.turns.push({ role: "agent", content: "injected", timestampMs: 1 });
    first!.metadata.injected = true;

    const second = await store.get("s1");
    expect(second!.slots.orderId).toBe("A1");
    expect(second!.turns).toHaveLength(1);
    expect(second!.metadata.injected).toBeUndefined();
  });

  it("isolates records returned by list()", async () => {
    const store = new MemorySessionStore();
    await store.set("s1", makeRecord("s1", { turns: [{ role: "user", content: "a", timestampMs: 0 }] }));

    const listed = await store.list();
    listed[0].turns.push({ role: "agent", content: "b", timestampMs: 1 });

    const reread = await store.get("s1");
    expect(reread!.turns).toHaveLength(1);
  });

  it("persists mutations made through the manager", async () => {
    const manager = new SessionManager();
    await manager.createSession({ id: "s1" });

    await manager.setSlot("s1", "orderId", "A1");
    await manager.addTurn("s1", { role: "user", content: "hi", timestampMs: 0 });

    const record = await manager.getSession("s1");
    expect(record!.slots.orderId).toBe("A1");
    expect(record!.turns).toHaveLength(1);
  });
});

describe("SessionManager TTL accounting", () => {
  it("counts expired sessions in stats", async () => {
    const expired: string[] = [];
    const store = new MemorySessionStore({ onExpired: (id) => expired.push(id) });
    await store.set("gone", makeRecord("gone", { lastActiveAt: Date.now() - 120_000, ttlMs: 1000 }));

    await store.get("gone");
    expect(expired).toEqual(["gone"]);

    const manager = new SessionManager({ store });
    manager.recordExpiration(expired.length);
    expect((await manager.getStats()).totalExpired).toBe(1);
  });

  it("does not count active sessions as expired", async () => {
    const manager = new SessionManager();
    await manager.createSession({ id: "live" });
    await manager.getSession("live");
    expect((await manager.getStats()).totalExpired).toBe(0);
  });
});

describe("SessionManager concurrency limit", () => {
  it("does not overshoot maxConcurrent under simultaneous creates", async () => {
    const manager = new SessionManager({ maxConcurrent: 3 });

    // Fire 10 creates at once: a naive check-then-insert admits them all.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => manager.createSession({ id: `s${i}` })),
    );

    const created = results.filter((r) => r.status === "fulfilled").length;
    expect(created).toBe(3);
    expect((await manager.getStats()).activeCount).toBe(3);
  });

  it("allows a new session once one is released", async () => {
    const manager = new SessionManager({ maxConcurrent: 1 });
    await manager.createSession({ id: "a" });
    await expect(manager.createSession({ id: "b" })).rejects.toThrow(/concurrency limit/);

    await manager.endSession("a");
    await expect(manager.createSession({ id: "b" })).resolves.toBeDefined();
  });
});

describe("SessionManager zero-persistence default", () => {
  it("purges sessions on end when no store was provided", async () => {
    const manager = new SessionManager();
    await manager.createSession({ id: "s1" });
    const ended = await manager.endSession("s1");

    expect(ended).not.toBeNull();
    expect(await manager.getSession("s1")).toBeNull();
  });
});
