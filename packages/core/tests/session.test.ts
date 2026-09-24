import { describe, it, expect, vi } from "vitest";
import {
  SessionManager,
  createSessionManager,
  MemorySessionStore,
  createMemorySessionStore,
  createAgent,
  SessionStore,
  SessionRecord,
} from "../src/index.js";

describe("SessionManager — Ephemeral Default (No Database)", () => {
  it("keeps session in memory while call is active, but purges immediately upon endSession", async () => {
    const manager = createSessionManager();

    // 1. Create active call session
    const session = await manager.createSession({
      id: "call-123",
      metadata: { from: "+15551234567" },
      slots: { callerName: "Alex" },
    });

    expect(session.id).toBe("call-123");
    expect(await manager.getActiveCount()).toBe(1);

    // Can read slots during active call
    expect(await manager.getSlot("call-123", "callerName")).toBe("Alex");

    // 2. Call ends — without a user-provided database, it must purge from RAM
    await manager.endSession("call-123");

    // Must be completely purged
    expect(await manager.getSession("call-123")).toBeNull();
    expect(await manager.getActiveCount()).toBe(0);

    await manager.close();
  });

  it("updates slots and adds conversation turns while active", async () => {
    const manager = createSessionManager();

    await manager.createSession({ id: "call-456" });

    await manager.setSlot("call-456", "orderId", "ACM-99");
    expect(await manager.getSlot("call-456", "orderId")).toBe("ACM-99");

    await manager.addTurn("call-456", {
      role: "user",
      content: "Where is my order?",
      timestampMs: 100,
    });

    const session = await manager.getSession("call-456");
    expect(session?.turns.length).toBe(1);
    expect(session?.turns[0].content).toBe("Where is my order?");

    await manager.close();
  });
});

describe("SessionManager — User-Provided Database Store", () => {
  it("persists ended sessions if and only if user provides an external database/store", async () => {
    // Custom database mock store provided by user
    const dbMap = new Map<string, SessionRecord>();
    const userDbStore: SessionStore = {
      async get(id: string) { return dbMap.get(id) ?? null; },
      async set(id: string, record: SessionRecord) { dbMap.set(id, record); },
      async delete(id: string) { return dbMap.delete(id); },
      async touch(id: string) { const r = dbMap.get(id); if (r) r.lastActiveAt = Date.now(); },
      async list() { return Array.from(dbMap.values()); },
      async clear() { dbMap.clear(); },
    };

    const manager = createSessionManager({
      store: userDbStore,
    });

    await manager.createSession({
      id: "call-persisted",
      metadata: { from: "+15559998888" },
      slots: { verified: true },
    });

    // When ended, because user explicitly provided a store, it is preserved in their database
    await manager.endSession("call-persisted");

    const saved = await userDbStore.get("call-persisted");
    expect(saved).not.toBeNull();
    expect(saved?.state).toBe("ended");
    expect(saved?.slots.verified).toBe(true);

    await manager.close();
  });
});

describe("SessionManager — Scaling & Concurrency Limits", () => {
  it("enforces maxConcurrent limit to prevent instance overload", async () => {
    const manager = createSessionManager({
      maxConcurrent: 2,
    });

    let limitReachedEvents = 0;
    manager.on("concurrencyLimitReached", () => {
      limitReachedEvents++;
    });

    await manager.createSession({ id: "call-1" });
    await manager.createSession({ id: "call-2" });

    expect(await manager.getActiveCount()).toBe(2);

    // 3rd call should be rejected
    await expect(manager.createSession({ id: "call-3" })).rejects.toThrow(
      /Session concurrency limit reached/
    );

    expect(limitReachedEvents).toBe(1);

    // End call-1, should allow new call
    await manager.endSession("call-1");
    expect(await manager.getActiveCount()).toBe(1);

    const call4 = await manager.createSession({ id: "call-4" });
    expect(call4.id).toBe("call-4");

    await manager.close();
  });

  it("integrates seamlessly into createAgent builder API", () => {
    const agent = createAgent("SupportBot")
      .system("You are support.")
      .action("test", "test action", "hello")
      .maxConcurrent(10)
      .sessions({ ttlMs: 15 * 60 * 1000 })
      .build();

    expect(agent.sessions).toBeDefined();
    expect(typeof agent.sessions.createSession).toBe("function");
    expect(typeof agent.sessions.getActiveCount).toBe("function");
  });
});
