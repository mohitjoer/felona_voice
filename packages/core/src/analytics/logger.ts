import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationTurn, Session, ActionMatch } from "../types.js";

/**
 * CallLogger — Logs structured conversation data for JEV training and analytics.
 *
 * Every completed call produces a log file with:
 * - Session metadata
 * - All conversation turns
 * - JEV decisions (action selected, confidence, candidates)
 * - Timing information
 *
 * These logs are the training data for the JEV predictor (Phase 2).
 */
export class CallLogger {
  private readonly logDir: string;
  private readonly level: "debug" | "info" | "warn" | "error";
  private readonly enabled: boolean;

  constructor(options?: {
    logDir?: string;
    level?: "debug" | "info" | "warn" | "error";
    enabled?: boolean;
  }) {
    this.logDir = options?.logDir ?? "./call-logs";
    this.level = options?.level ?? "info";
    this.enabled = options?.enabled ?? true;
  }

  /**
   * Log a complete call session.
   * This is called when a call ends.
   */
  async logCall(data: CallLogEntry): Promise<string | null> {
    if (!this.enabled) return null;

    await mkdir(this.logDir, { recursive: true });

    const filename = `${data.session.id}_${Date.now()}.json`;
    const filepath = join(this.logDir, filename);

    const logData: CallLogFile = {
      version: "1.0",
      sessionId: data.session.id,
      startedAt: data.session.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - data.session.startedAt.getTime(),
      metadata: data.session.metadata,
      turns: data.turns,
      decisions: data.decisions,
      metrics: data.metrics,
    };

    await writeFile(filepath, JSON.stringify(logData, null, 2));
    this.log("info", `Call log saved: ${filepath}`);

    return filepath;
  }

  /**
   * Log a JEV decision for the current session.
   * Used to build (context, action) training pairs.
   */
  logDecision(decision: JEVDecisionLog): void {
    if (!this.enabled) return;
    this.log(
      "debug",
      `JEV decision: ${decision.selectedAction} (confidence: ${decision.confidence.toFixed(3)})`,
    );
  }

  /** General-purpose log */
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] < levels[this.level]) return;

    const prefix = `[Felona/${level.toUpperCase()}]`;
    const timestamp = new Date().toISOString();

    if (data) {
      console.log(`${prefix} ${timestamp} ${message}`, data);
    } else {
      console.log(`${prefix} ${timestamp} ${message}`);
    }
  }
}

/** Data for a complete call log */
export interface CallLogEntry {
  session: Session;
  turns: ConversationTurn[];
  decisions: JEVDecisionLog[];
  metrics: CallMetrics;
}

/** A single JEV decision record */
export interface JEVDecisionLog {
  /** Timestamp of the decision */
  timestampMs: number;
  /** The context string that was embedded */
  contextSummary: string;
  /** The action that was selected */
  selectedAction: string;
  /** Confidence score */
  confidence: number;
  /** Top N candidates with scores */
  candidates: Array<{ actionId: string; score: number }>;
  /** Time taken for the JEV decision (ms) */
  latencyMs: number;
}

/** Call-level metrics */
export interface CallMetrics {
  /** Total number of turns */
  totalTurns: number;
  /** Average JEV decision latency (ms) */
  avgJEVLatencyMs: number;
  /** Average STT latency (ms) */
  avgSTTLatencyMs?: number;
  /** Average TTS latency (ms) */
  avgTTSLatencyMs?: number;
  /** Number of barge-in events */
  bargeInCount: number;
  /** Average JEV confidence */
  avgConfidence: number;
}

/** Structure of a call log file */
export interface CallLogFile {
  version: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  metadata: Record<string, unknown>;
  turns: ConversationTurn[];
  decisions: JEVDecisionLog[];
  metrics: CallMetrics;
}

export function createCallLogger(options?: {
  logDir?: string;
  level?: "debug" | "info" | "warn" | "error";
  enabled?: boolean;
}): CallLogger {
  return new CallLogger(options);
}
