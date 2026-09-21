import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ConversationTurn,
  MemoryManager,
  ConversationContext,
  Session,
} from "../types.js";

/**
 * ConversationMemory — Manages the sliding window of conversation turns,
 * extracted slots, and builds the full context for JEV.
 *
 * This is the agent's short-term memory for a single session.
 */
export class ConversationMemory extends EventEmitter implements MemoryManager {
  private turns: ConversationTurn[] = [];
  private slots: Map<string, unknown> = new Map();
  private readonly maxTurns: number;

  constructor(options?: { maxTurns?: number }) {
    super();
    this.maxTurns = options?.maxTurns ?? 50;
  }

  addTurn(turn: ConversationTurn): void {
    this.turns.push(turn);

    // Sliding window — drop oldest turns if we exceed the max
    if (this.turns.length > this.maxTurns) {
      const dropped = this.turns.shift();
      this.emit("turnDropped", dropped);
    }

    this.emit("turnAdded", turn);
  }

  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  getRecentTurns(n: number): ConversationTurn[] {
    return this.turns.slice(-n);
  }

  setSlot(key: string, value: unknown): void {
    const previous = this.slots.get(key);
    this.slots.set(key, value);
    this.emit("slotUpdated", { key, value, previous });
  }

  getSlot(key: string): unknown {
    return this.slots.get(key);
  }

  getSlots(): Record<string, unknown> {
    return Object.fromEntries(this.slots);
  }

  clear(): void {
    this.turns = [];
    this.slots.clear();
    this.emit("cleared");
  }

  /**
   * Build the full conversation context for JEV.
   * This is the primary input to the JEV engine's encode() method.
   */
  buildContext(
    session: Session,
    systemPrompt: string,
    currentUtterance?: string,
  ): ConversationContext {
    return {
      session,
      turns: this.getTurns(),
      currentUtterance: currentUtterance ?? "",
      slots: this.getSlots(),
      systemPrompt,
    };
  }

  /**
   * Serialize the conversation to a format suitable for LLM context.
   * Returns an array of {role, content} messages.
   */
  toLLMHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    return this.turns.map((turn) => ({
      role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
      content: turn.content,
    }));
  }

  /**
   * Get a text summary of the conversation so far.
   * Useful for embedding into the JEV context vector.
   */
  toContextString(): string {
    return this.turns
      .map((t) => `${t.role === "user" ? "User" : "Agent"}: ${t.content}`)
      .join("\n");
  }

  /** Number of turns in memory */
  get length(): number {
    return this.turns.length;
  }

  /** Get the last turn (or undefined if empty) */
  get lastTurn(): ConversationTurn | undefined {
    return this.turns[this.turns.length - 1];
  }
}

/**
 * Create a new ConversationMemory instance.
 * Factory function for convenience.
 */
export function createMemory(
  options?: { maxTurns?: number },
): ConversationMemory {
  return new ConversationMemory(options);
}
