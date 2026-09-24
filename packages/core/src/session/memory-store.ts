import type { SessionRecord, SessionStore, SessionState } from "../types.js";

export interface MemorySessionStoreOptions {
  /** Default TTL in milliseconds for stored sessions (default: 30 minutes) */
  defaultTtlMs?: number;
  /** How often to run the cleanup sweep in milliseconds (default: 60 seconds) */
  cleanupIntervalMs?: number;
}

/**
 * MemorySessionStore — In-memory session storage with TTL expiration,
 * touch updating, and fast querying.
 *
 * For single-node setups or local testing. For multi-node distributed scaling,
 * implement the SessionStore interface with Redis or a database.
 */
export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();
  private defaultTtlMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: MemorySessionStoreOptions) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 30 * 60 * 1000; // 30 minutes
    const interval = options?.cleanupIntervalMs ?? 60 * 1000;

    if (interval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupExpired(), interval);
      // Unref so it doesn't hold open Node process in unit tests
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;

    if (this.isExpired(record)) {
      this.records.delete(id);
      return null;
    }

    return { ...record };
  }

  async set(id: string, record: SessionRecord): Promise<void> {
    const ttl = record.ttlMs ?? this.defaultTtlMs;
    this.records.set(id, {
      ...record,
      id,
      ttlMs: ttl,
      lastActiveAt: record.lastActiveAt || Date.now(),
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async touch(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record && !this.isExpired(record)) {
      record.lastActiveAt = Date.now();
    }
  }

  async list(filter?: { state?: SessionState }): Promise<SessionRecord[]> {
    const now = Date.now();
    const result: SessionRecord[] = [];

    for (const [id, record] of this.records) {
      if (this.isExpired(record, now)) {
        this.records.delete(id);
        continue;
      }

      if (filter?.state && record.state !== filter.state) {
        continue;
      }

      result.push({ ...record });
    }

    return result;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.records.clear();
  }

  private isExpired(record: SessionRecord, now = Date.now()): boolean {
    const ttl = record.ttlMs ?? this.defaultTtlMs;
    if (ttl <= 0) return false;
    return now - record.lastActiveAt > ttl;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (this.isExpired(record, now)) {
        this.records.delete(id);
      }
    }
  }

  get size(): number {
    return this.records.size;
  }
}

export function createMemorySessionStore(options?: MemorySessionStoreOptions): MemorySessionStore {
  return new MemorySessionStore(options);
}
