/**
 * Post-call analysis.
 *
 * Derives structure from a finished conversation: how it went, how the caller
 * felt, and how much the agent was guessing. It exists because the same turn log
 * is the training data for a JEV predictor — a call that ended in three
 * fallbacks and a transfer is exactly the example a predictor should learn from,
 * and there is no other place that information exists.
 *
 * Deliberately lexicon- and rule-based rather than model-based: this runs after
 * every call, must be deterministic, and must not add a provider to a framework
 * whose whole premise is running without one.
 */

import type { ConversationTurn, Session } from "../types.js";

export type Sentiment = "positive" | "neutral" | "negative";

export interface SentimentScore {
  /** -1 (hostile) to +1 (delighted). */
  score: number;
  label: Sentiment;
  /** Caller turns that drove the score, for debugging a surprising result. */
  signals: string[];
}

export interface ConfidenceProfile {
  /** Mean JEV confidence across the call. */
  average: number;
  /** Decisions below the confidence threshold — the agent was guessing. */
  lowConfidenceCount: number;
  /** Share of turns that routed to `fallback`. */
  fallbackRate: number;
  /** Score for the action-space as a whole, 0-1. */
  grade: "strong" | "adequate" | "weak";
}

export interface CallAnalysis {
  sessionId: string;
  durationMs: number;
  turnCount: number;
  sentiment: SentimentScore;
  confidence: ConfidenceProfile;
  /** True when the caller asked for a human, or frustration signals appeared. */
  escalationRisk: boolean;
  /** Whether the call ended with the caller still asking for something. */
  unresolved: boolean;
  /** Whether the caller's request was addressed. */
  resolved: boolean;
  /** How `resolved` was decided — useful when it disagrees with the summary. */
  resolutionSource: "explicit" | "action" | "heuristic";
  /** Actions used, most frequent first. */
  actionBreakdown: Array<{ actionId: string; count: number }>;
  /** 0-100. A blunt rollup for dashboards; the fields above explain it. */
  outcomeScore: number;
  /** One-line summary suitable for a log or a CRM field. */
  summary: string;
}

export interface AnalyzeOptions {
  /**
   * Decide whether the call was actually resolved.
   *
   * The heuristic below can only see the conversation. When a real outcome
   * exists (ticket closed, payment taken, issue marked solved) pass it in and it
   * wins over the guess.
   */
  resolve?: (turns: ConversationTurn[]) => boolean | undefined;
  /** Treat these action ids as a successful ending. */
  successActions?: string[];
  /** Treat these action ids as an escalation. */
  escalationActions?: string[];
}

// ─── Sentiment lexicons ────────────────────────────────────────────────────

const POSITIVE = new Set([
  "thanks", "thank", "great", "perfect", "awesome", "excellent", "lovely",
  "appreciate", "helpful", "yes", "sure", "sounds", "good", "wonderful",
  "brilliant", "cheers", "grateful", "nice", "happy", "please",
]);

const NEGATIVE = new Set([
  "angry", "furious", "unacceptable", "terrible", "awful", "horrible",
  "worst", "useless", "ridiculous", "disappointed", "frustrated", "annoying",
  "broken", "wrong", "still", "waiting", "nobody", "cancel", "refund",
  "complaint", "manager", "supervisor", "never", "again", "hopeless", "pathetic",
  "scam", "unhappy", "upset", "sick", "tired", "fed up",
]);

/** Phrases that reliably mean the caller is about to give up. */
const ESCALATION_PHRASES = [
  "let me speak to", "speak to a manager", "speak to someone", "human being",
  "real person", "supervisor", "escalate", "complaint", "cancel my",
  "i want a refund", "never mind", "forget it", "not good enough",
];

/**
 * Sentiment across a conversation.
 *
 * Weighted toward the caller's own turns: an agent turn reading "I'm sorry to
 * hear that" is not evidence the caller is happy, and scoring it as such is how
 * a naive analyser ends up reporting an angry caller as satisfied.
 */
export function analyzeSentiment(turns: ConversationTurn[]): SentimentScore {
  const signals: string[] = [];
  let total = 0;
  let scored = 0;

  for (const turn of turns) {
    // Only the caller's language reflects the caller's state.
    if (turn.role !== "user") continue;

    const words = turn.content
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    if (words.length === 0) continue;

    let positive = 0;
    let negative = 0;

    for (const word of words) {
      if (POSITIVE.has(word)) positive++;
      if (NEGATIVE.has(word)) negative++;
    }

    // "not good", "never mind" — negation inverts the token, so a bare word count
    // is not enough on its own.
    const negatedPositive = /\b(not|no|isn't|wasn't|never)\s+(good|great|helpful|working)\b/.test(
      turn.content.toLowerCase(),
    );
    if (negatedPositive) {
      positive = Math.max(0, positive - 1);
      negative++;
      signals.push(`negated positive: "${turn.content.slice(0, 40)}"`);
    }

    const delta = positive - negative;
    if (delta !== 0) {
      total += delta;
      scored++;
      if (delta > 0) signals.push(`positive: "${turn.content.slice(0, 40)}"`);
      else signals.push(`negative: "${turn.content.slice(0, 40)}"`);
    }
  }

  if (scored === 0) {
    return { score: 0, label: "neutral", signals: [] };
  }

  // Normalize by the number of scored turns, then damp so one emphatic caller
  // does not dominate a 20-turn call.
  const raw = total / scored;
  const score = Math.max(-1, Math.min(1, Math.tanh(raw / 2)));

  const label: Sentiment = score > 0.15 ? "positive" : score < -0.15 ? "negative" : "neutral";

  return { score: Number(score.toFixed(3)), label, signals: signals.slice(0, 5) };
}

/** How often the agent was uncertain, and how good the action space looks. */
export function analyzeConfidence(
  decisions: Array<{ confidence: number; selectedAction: string }>,
  threshold: number,
  turnCount: number,
): ConfidenceProfile {
  if (decisions.length === 0) {
    return { average: 0, lowConfidenceCount: 0, fallbackRate: 0, grade: "weak" };
  }

  const average =
    decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length;

  const lowConfidenceCount = decisions.filter((d) => d.confidence < threshold).length;
  const fallbackCount = decisions.filter((d) => d.selectedAction === "fallback").length;

  // Fallback rate is per decision, not per turn: several decisions can happen
  // inside one turn with preemptive routing.
  const fallbackRate = fallbackCount / decisions.length;

  // Blend mean confidence with how often the agent punted. Either alone is
  // misleading — high confidence on a wrong-but-clear route still fails callers.
  const blended = average * (1 - fallbackRate);
  const grade: ConfidenceProfile["grade"] =
    blended >= 0.55 && fallbackRate <= 0.15
      ? "strong"
      : blended >= 0.35 && fallbackRate <= 0.4
        ? "adequate"
        : "weak";

  void turnCount;

  return {
    average: Number(average.toFixed(3)),
    lowConfidenceCount,
    fallbackRate: Number(fallbackRate.toFixed(3)),
    grade,
  };
}

function detectEscalation(
  turns: ConversationTurn[],
  escalationActions: string[],
): boolean {
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const lower = turn.content.toLowerCase();
    for (const phrase of ESCALATION_PHRASES) {
      if (lower.includes(phrase)) return true;
    }
  }

  for (const turn of turns) {
    if (turn.actionId && escalationActions.includes(turn.actionId)) return true;
  }

  return false;
}

/** Was the caller's last request actually addressed? */
function detectUnresolved(turns: ConversationTurn[]): boolean {
  if (turns.length < 2) return true;

  // The call ends on the caller's words with no agent reply: they were cut off,
  // or the agent gave up mid-conversation.
  const last = turns[turns.length - 1];
  if (last.role === "user") return true;

  const finalAgentTurn = last.content.toLowerCase();
  return (
    finalAgentTurn.includes("let me know if") === false &&
    /(could you (please )?(call|confirm|provide)|i'?ll (call|email|follow))/i.test(
      finalAgentTurn,
    )
  );
}

/** Analyse a finished call. */
export function analyzeCall(
  session: Session,
  turns: ConversationTurn[],
  decisions: Array<{ confidence: number; selectedAction: string }>,
  options?: AnalyzeOptions,
): CallAnalysis {
  const threshold = 0.35;
  const sentiment = analyzeSentiment(turns);
  const confidence = analyzeConfidence(decisions, threshold, turns.length);
  const escalationRisk = detectEscalation(
    turns,
    options?.escalationActions ?? ["escalate", "escalate_supervisor"],
  );
  const unresolved = detectUnresolved(turns);

  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.role !== "agent" || !turn.actionId) continue;
    counts.set(turn.actionId, (counts.get(turn.actionId) ?? 0) + 1);
  }
  const actionBreakdown = [...counts.entries()]
    .map(([actionId, count]) => ({ actionId, count }))
    .sort((a, b) => b.count - a.count);

  const explicit = options?.resolve?.(turns);
  const successActionHit =
    options?.successActions?.some((id) => counts.has(id)) ?? false;

  let resolutionSource: CallAnalysis["resolutionSource"];
  let resolved: boolean;

  if (explicit !== undefined) {
    // A real outcome from the caller always wins over inference.
    resolved = explicit;
    resolutionSource = "explicit";
  } else if (successActionHit) {
    resolved = true;
    resolutionSource = "action";
  } else {
    resolved = !unresolved && !escalationRisk;
    resolutionSource = "heuristic";
  }

  // 0-100 rollup. Sentiment and routing quality both matter, and a hostile
  // caller who got an answer still had a bad call.
  const outcomeScore = Math.round(
    Math.max(0, Math.min(100,
      50 +
      sentiment.score * 25 +
      (confidence.average - 0.5) * 40 -
      confidence.fallbackRate * 30 -
      (escalationRisk ? 15 : 0) -
      (resolved ? 0 : 15),
    )),
  );

  const summary = buildSummary({
    sentiment,
    confidence,
    escalationRisk,
    resolved,
    outcomeScore,
    turnCount: turns.length,
  });

  return {
    sessionId: session.id,
    durationMs: Date.now() - session.startedAt.getTime(),
    turnCount: turns.length,
    sentiment,
    confidence,
    escalationRisk,
    unresolved,
    resolved,
    resolutionSource,
    actionBreakdown,
    outcomeScore,
    summary,
  };
}

function buildSummary(input: {
  sentiment: SentimentScore;
  confidence: ConfidenceProfile;
  escalationRisk: boolean;
  resolved: boolean;
  outcomeScore: number;
  turnCount: number;
}): string {
  const parts: string[] = [];

  parts.push(
    input.resolved ? "Resolved" : input.escalationRisk ? "Escalated" : "Unresolved",
  );
  parts.push(`${input.sentiment.label} caller`);
  parts.push(`routing ${input.confidence.grade}`);

  if (input.confidence.fallbackRate > 0.3) {
    parts.push(`${Math.round(input.confidence.fallbackRate * 100)}% fallback`);
  }

  parts.push(`score ${input.outcomeScore}/100`);

  return `${parts.join(" · ")} over ${input.turnCount} turns`;
}
