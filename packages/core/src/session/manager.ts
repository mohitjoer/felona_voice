import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  SessionRecord,
  SessionStore,
  SessionManagerOptions,
  SessionStats,
  ConversationTurn,
  SessionAccessor,
} from "../types.js";
import { MemorySessionStore } from "./memory-store.js";

/**
 * SessionManager — Manages voice agent session lifecycles, slot persistence,
 * concurrency controls, and horizontal scalability.
 *
 * Pluggable store backend allows scaling out across multiple servers or worker processes
 * using shared stores (such as Redis) while preserving caller context, memory, and slots.
 */
export class SessionManager extends EventEmitter implements SessionAccessor {
  private store: SessionStore;
  private hasUserDatabase: boolean;
  private maxConcurrent: number;
  private ttlMs: number;
  private totalCreated = 0;
  private totalExpired = 0;
  /**
   * Sessions currently being created.
   *
   * `canAcceptSession()` awaits the store, so N concurrent callers can all
   * observe the same count and all pass the limit. Counting in-flight creates
   * closes that window.
   */
  private creating = 0;

  constructor(options?: SessionManagerOptions) {
    super();
    this.hasUserDatabase = Boolean(options?.store);
    this.store =
      options?.store ??
      new MemorySessionStore({
        defaultTtlMs: options?.ttlMs,
        cleanupIntervalMs: options?.cleanupIntervalMs,
        onExpired: () => {
          this.totalExpired++;
        },
      });
    this.maxConcurrent = options?.maxConcurrent ?? Infinity;
    this.ttlMs = options?.ttlMs ?? 30 * 60 * 1000;
  }

  /**
   * Check if the current agent instance can accept a new concurrent session.
   *
   * Informational only — `createSession()` is authoritative, because this
   * cannot see sessions that are mid-creation.
   */
  async canAcceptSession(): Promise<boolean> {
    if (this.maxConcurrent === Infinity) return true;
    const active = await this.getActiveCount();
    return active + this.creating < this.maxConcurrent;
  }

  /**
   * Create and persist a new session record.
   *
   * This is the single concurrency gate. The slot is reserved *synchronously*
   * before any `await`, because `getActiveCount()` yields — reserving afterwards
   * let every simultaneous caller observe the same count and all pass the
   * limit together.
   */
  async createSession(options?: {
    id?: string;
    metadata?: Record<string, unknown>;
    slots?: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<SessionRecord> {
    if (this.maxConcurrent !== Infinity) {
      this.creating++;
    }

    try {
      if (this.maxConcurrent !== Infinity) {
        const active = await this.getActiveCount();
        // `creating` includes this call, so discount it.
        const projected = active + this.creating - 1;

        if (projected >= this.maxConcurrent) {
          this.emit("concurrencyLimitReached", active, this.maxConcurrent);
          throw new Error(
            `Session concurrency limit reached: ${active} active sessions (max: ${this.maxConcurrent})`,
          );
        }
      }

      const id = options?.id || randomUUID();
      const now = Date.now();

      const record: SessionRecord = {
        id,
        createdAt: now,
        lastActiveAt: now,
        state: "active",
        metadata: options?.metadata ? { ...options.metadata } : {},
        slots: options?.slots ? { ...options.slots } : {},
        turns: [],
        ttlMs: options?.ttlMs ?? this.ttlMs,
      };

      await this.store.set(id, record);
      this.totalCreated++;
      this.emit("sessionCreated", record);
      return record;
    } finally {
      if (this.maxConcurrent !== Infinity) {
        this.creating--;
      }
    }
  }

  /**
   * Retrieve a session record by ID.
   */
  async getSession(id: string): Promise<SessionRecord | null> {
    return this.store.get(id);
  }

  /**
   * Update and persist changes to a session record.
   */
  async saveSession(record: SessionRecord): Promise<void> {
    record.lastActiveAt = Date.now();
    await this.store.set(record.id, record);
    this.emit("sessionUpdated", record);
  }

  /**
   * Touch a session to keep it alive (resets TTL inactivity timer).
   */
  async touch(id: string): Promise<void> {
    await this.store.touch(id);
  }

  /**
   * Update slots for a session.
   */
  async setSlot(id: string, key: string, value: unknown): Promise<void> {
    const record = await this.store.get(id);
    if (!record) throw new Error(`Session "${id}" not found`);

    record.slots[key] = value;
    await this.saveSession(record);
  }
  /**
   * Retrieve a slot value from a session.
   */
  async getSlot(id: string, key: string): Promise<unknown> {
    const record = await this.store.get(id);
    return record?.slots[key];
  }

  /**
   * Get all slots for a session.
   */
  async getSlots(id: string): Promise<Record<string, unknown>> {
    const record = await this.store.get(id);
    return record?.slots ?? {};
  }

  /**
   * Append a conversation turn to the session history.
   */
  async addTurn(id: string, turn: ConversationTurn): Promise<void> {
    const record = await this.store.get(id);
    if (!record) return;

    record.turns.push(turn);
    await this.saveSession(record);
  }

  /**
   * Update session metadata (e.g. telephony call details).
   */
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const record = await this.store.get(id);
    if (!record) throw new Error(`Session "${id}" not found`);

    Object.assign(record.metadata, metadata);
    await this.saveSession(record);
  }

  /**
   * Mark a session as ended.
   * If using default in-memory store without an explicit user-provided database,
   * automatically purges the session from memory immediately upon call end.
   */
  async endSession(id: string): Promise<SessionRecord | null> {
    const record = await this.store.get(id);
    if (!record) return null;

    record.state = "ended";
    record.lastActiveAt = Date.now();
    this.emit("sessionEnded", record);

    if (this.hasUserDatabase) {
      // User provided database connection/store: persist the ended state
      await this.store.set(id, record);
    } else {
      // Default: purge immediately, do not store anywhere
      await this.store.delete(id);
    }

    return record;
  }

  /**
   * Delete a session completely.
   */
  async deleteSession(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /**
   * Get all currently active sessions.
   */
  async getActiveSessions(): Promise<SessionRecord[]> {
    return this.store.list({ state: "active" });
  }

  /**
   * Get count of active sessions.
   */
  async getActiveCount(): Promise<number> {
    const active = await this.getActiveSessions();
    return active.length;
  }

  /**
   * Find sessions matching a specific metadata key-value pair.
   * Useful for finding calls by caller phone number, customer ID, or account SID.
   */
  async findSessionsByMetadata(key: string, value: unknown): Promise<SessionRecord[]> {
    const all = await this.store.list();
    return all.filter((r) => r.metadata && r.metadata[key] === value);
  }

  /**
   * Find prior sessions for a specific mobile phone caller.
   */
  async findSessionsByCaller(callerPhone: string): Promise<SessionRecord[]> {
    const all = await this.store.list();
    return all.filter(
      (r) =>
        r.metadata &&
        (r.metadata.from === callerPhone ||
          r.metadata.caller === callerPhone ||
          r.metadata.phoneNumber === callerPhone)
    );
  }

  /**
   * Get session telemetry and operational stats.
   *
   * `totalExpired` counts sessions dropped by the built-in memory store's TTL
   * sweep. A custom `SessionStore` expires its own records, so it should call
   * `SessionManager.recordExpiration()` to keep this counter accurate.
   */
  async getStats(): Promise<SessionStats> {
    const activeCount = await this.getActiveCount();
    return {
      activeCount,
      totalCreated: this.totalCreated,
      maxConcurrent: this.maxConcurrent,
      totalExpired: this.totalExpired,
    };
  }

  /**
   * Report that the underlying store expired a session.
   *
   * Custom stores own their own expiry, so they call this to keep
   * `getStats().totalExpired` meaningful.
   */
  recordExpiration(count = 1): void {
    this.totalExpired += count;
  }

  /**
   * Close the session manager and release resources.
   */
  async close(): Promise<void> {
    await this.store.close?.();
  }
}

export function createSessionManager(options?: SessionManagerOptions): SessionManager {
  return new SessionManager(options);
}
