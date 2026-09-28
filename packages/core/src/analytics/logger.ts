import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationTurn, Session } from "../types.js";

/**
 * Make a session ID safe to use as a filename component.
 *
 * Session IDs can be caller-supplied (`interact({ sessionId })`, or a telephony
 * stream SID), so using one verbatim would let `../../etc/cron.d/x` escape the
 * log directory.
 */
function safeFilenameComponent(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
  const trimmed = cleaned.slice(0, 64);
  return trimmed.length > 0 ? trimmed : "session";
}

/**
 * CallLogger — Logs structured conversation data for JEV training and analytics.
 *
 * Every completed call can produce a log file with:
 * - Session metadata
 * - All conversation turns
 * - JEV decisions (action selected, confidence, candidates)
 * - Timing information
 *
 * Nothing is written unless the caller explicitly supplies a `logDir`.
 */
export class CallLogger {
  private readonly logDir: string;
  private readonly level: "debug" | "info" | "warn" | "error";
  private readonly enabled: boolean;
  private readonly format: "text" | "json";

  constructor(options?: {
    logDir?: string;
    level?: "debug" | "info" | "warn" | "error";
    enabled?: boolean;
    /**
     * Output shape. Default: `text`.
     *
     * `json` emits one JSON object per line, which is what a log shipper
     * (Loki, CloudWatch, Datadog) can index and query. `text` stays readable
     * in a terminal. The choice is the operator's because it depends on where
     * the logs go, not on how the framework behaves.
     */
    format?: "text" | "json";
  }) {
    this.logDir = options?.logDir ?? "";
    this.level = options?.level ?? "info";
    this.format = options?.format ?? "text";
    // Never persist call logs to disk unless user explicitly provided a logDir
    this.enabled = options?.enabled !== undefined ? options.enabled : Boolean(options?.logDir);
  }

  /**
   * Log a complete call session.
   * Only saves to disk if the user explicitly provided a logDir location.
   */
  async logCall(data: CallLogEntry): Promise<string | null> {
    if (!this.enabled || !this.logDir) return null;

    await mkdir(this.logDir, { recursive: true });

    const filename = `${safeFilenameComponent(data.session.id)}_${Date.now()}.json`;
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

    const timestamp = new Date().toISOString();

    if (this.format === "json") {
      // One object per line, so a shipper can parse it without a regex and a
      // human can still read it.
      const entry = JSON.stringify({
        time: timestamp,
        level,
        component: "felona",
        msg: message,
        ...(data ?? {}),
      });
      if (level === "error") console.error(entry);
      else if (level === "warn") console.warn(entry);
      else if (level === "debug") console.debug(entry);
      else console.log(entry);
      return;
    }

    const prefix = `[Felona/${level.toUpperCase()}]`;
    const line = `${prefix} ${timestamp} ${message}`;

    // Route by severity so errors and warnings are visible in default
    // console filters and reach log shippers that read stderr.
    if (level === "error") {
      if (data) console.error(line, data);
      else console.error(line);
    } else if (level === "warn") {
      if (data) console.warn(line, data);
      else console.warn(line);
    } else if (level === "debug") {
      if (data) console.debug(line, data);
      else console.debug(line);
    } else {
      if (data) console.log(line, data);
      else console.log(line);
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
  /**
   * Fingerprint of the embedded context, not the context itself.
   *
   * Previously this held the first 200 characters of what the caller said and
   * was never read back — a second verbatim copy of caller speech in the call
   * log, which for card-by-DTMF flows means a second copy of the card number.
   */
  contextFingerprint: string;
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
