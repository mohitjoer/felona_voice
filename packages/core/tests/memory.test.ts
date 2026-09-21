import { describe, it, expect } from "vitest";
import { ConversationMemory } from "../src/memory/context.js";
import type { Session } from "../src/types.js";

const mockSession: Session = {
  id: "test-session-1",
  startedAt: new Date("2026-09-21T12:00:00Z"),
  metadata: {},
  state: "active",
};

describe("ConversationMemory", () => {
  it("adds and retrieves turns", () => {
    const memory = new ConversationMemory();

    memory.addTurn({
      role: "user",
      content: "Hello",
      timestampMs: 0,
    });
    memory.addTurn({
      role: "agent",
      content: "Hi there!",
      timestampMs: 500,
      actionId: "greet",
      confidence: 0.95,
    });

    expect(memory.length).toBe(2);
    expect(memory.getTurns()).toHaveLength(2);
    expect(memory.getTurns()[0].content).toBe("Hello");
    expect(memory.getTurns()[1].actionId).toBe("greet");
  });

  it("respects sliding window max turns", () => {
    const memory = new ConversationMemory({ maxTurns: 3 });

    for (let i = 0; i < 5; i++) {
      memory.addTurn({
        role: "user",
        content: `Message ${i}`,
        timestampMs: i * 1000,
      });
    }

    expect(memory.length).toBe(3);
    // Oldest messages should be dropped
    expect(memory.getTurns()[0].content).toBe("Message 2");
    expect(memory.getTurns()[2].content).toBe("Message 4");
  });

  it("gets recent turns", () => {
    const memory = new ConversationMemory();

    for (let i = 0; i < 10; i++) {
      memory.addTurn({
        role: "user",
        content: `Message ${i}`,
        timestampMs: i * 1000,
      });
    }

    const recent = memory.getRecentTurns(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe("Message 7");
    expect(recent[2].content).toBe("Message 9");
  });

  it("manages slots", () => {
    const memory = new ConversationMemory();

    memory.setSlot("customerName", "Alice");
    memory.setSlot("orderId", "12345");

    expect(memory.getSlot("customerName")).toBe("Alice");
    expect(memory.getSlot("orderId")).toBe("12345");
    expect(memory.getSlot("nonexistent")).toBeUndefined();

    const allSlots = memory.getSlots();
    expect(allSlots).toEqual({
      customerName: "Alice",
      orderId: "12345",
    });
  });

  it("builds conversation context", () => {
    const memory = new ConversationMemory();

    memory.addTurn({ role: "user", content: "Hi", timestampMs: 0 });
    memory.addTurn({
      role: "agent",
      content: "Hello!",
      timestampMs: 500,
    });
    memory.setSlot("name", "Bob");

    const context = memory.buildContext(
      mockSession,
      "You are a helpful assistant.",
      "I need help with my order",
    );

    expect(context.session.id).toBe("test-session-1");
    expect(context.turns).toHaveLength(2);
    expect(context.currentUtterance).toBe("I need help with my order");
    expect(context.slots.name).toBe("Bob");
    expect(context.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("converts to LLM history format", () => {
    const memory = new ConversationMemory();

    memory.addTurn({ role: "user", content: "Hi", timestampMs: 0 });
    memory.addTurn({
      role: "agent",
      content: "Hello!",
      timestampMs: 500,
    });

    const history = memory.toLLMHistory();
    expect(history).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);
  });

  it("converts to context string", () => {
    const memory = new ConversationMemory();

    memory.addTurn({ role: "user", content: "Hi", timestampMs: 0 });
    memory.addTurn({
      role: "agent",
      content: "Hello!",
      timestampMs: 500,
    });

    const contextStr = memory.toContextString();
    expect(contextStr).toContain("User: Hi");
    expect(contextStr).toContain("Agent: Hello!");
  });

  it("clears all memory", () => {
    const memory = new ConversationMemory();

    memory.addTurn({ role: "user", content: "Hi", timestampMs: 0 });
    memory.setSlot("name", "Alice");

    memory.clear();

    expect(memory.length).toBe(0);
    expect(memory.getSlots()).toEqual({});
  });

  it("lastTurn returns the most recent turn", () => {
    const memory = new ConversationMemory();

    expect(memory.lastTurn).toBeUndefined();

    memory.addTurn({ role: "user", content: "Hi", timestampMs: 0 });
    memory.addTurn({
      role: "agent",
      content: "Hello!",
      timestampMs: 500,
    });

    expect(memory.lastTurn?.content).toBe("Hello!");
    expect(memory.lastTurn?.role).toBe("agent");
  });
});
