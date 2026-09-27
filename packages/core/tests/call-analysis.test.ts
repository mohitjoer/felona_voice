import { describe, it, expect } from "vitest";
import {
  analyzeCall,
  analyzeSentiment,
  analyzeConfidence,
} from "../src/analytics/call-analysis.js";
import type { ConversationTurn, Session } from "../src/types.js";

const session: Session = {
  id: "s1",
  startedAt: new Date(Date.now() - 60_000),
  metadata: {},
  state: "active",
};

const user = (content: string): ConversationTurn => ({
  role: "user",
  content,
  timestampMs: 0,
});

const agent = (content: string, actionId?: string): ConversationTurn => ({
  role: "agent",
  content,
  timestampMs: 0,
  actionId,
});

describe("sentiment", () => {
  it("reads a satisfied caller", () => {
    const result = analyzeSentiment([
      user("thanks, that's great, really helpful"),
      user("perfect, thank you so much"),
    ]);
    expect(result.label).toBe("positive");
    expect(result.score).toBeGreaterThan(0);
  });

  it("reads an angry caller", () => {
    const result = analyzeSentiment([
      user("this is completely unacceptable"),
      user("I am furious, this is ridiculous"),
    ]);
    expect(result.label).toBe("negative");
  });

  it("is neutral on plain speech", () => {
    const result = analyzeSentiment([user("I want to return an order")]);
    expect(result.label).toBe("neutral");
  });

  it("scores only the caller's turns", () => {
    // The agent apologising is not evidence the caller is happy.
    const withAgentApology = analyzeSentiment([
      user("I am furious about this"),
      agent("I'm so sorry, I understand your frustration, thank you for your patience"),
    ]);
    expect(withAgentApology.label).toBe("negative");
  });

  it("handles negation", () => {
    const result = analyzeSentiment([user("this is not good at all")]);
    expect(result.label).toBe("negative");
  });

  it("stays neutral when nothing is expressed", () => {
    const result = analyzeSentiment([user(""), user("...")]);
    expect(result).toEqual({ score: 0, label: "neutral", signals: [] });
  });

  it("damps a single emphatic turn in a long call", () => {
    const many = Array.from({ length: 20 }, () => user("what time do you close"));
    const result = analyzeSentiment([...many, user("this is absolutely disgusting and I want a manager")]);
    // One angry turn should not read as a uniformly hostile call.
    expect(result.score).toBeGreaterThan(-0.5);
  });
});

describe("confidence profile", () => {
  it("grades a confident action space as strong", () => {
    const result = analyzeConfidence(
      [
        { confidence: 0.8, selectedAction: "order_status" },
        { confidence: 0.75, selectedAction: "refund_request" },
        { confidence: 0.9, selectedAction: "greet" },
      ],
      0.35,
      3,
    );
    expect(result.grade).toBe("strong");
    expect(result.fallbackRate).toBe(0);
  });

  it("penalises heavy fallback use", () => {
    const result = analyzeConfidence(
      [
        { confidence: 0.8, selectedAction: "fallback" },
        { confidence: 0.8, selectedAction: "fallback" },
        { confidence: 0.8, selectedAction: "order_status" },
      ],
      0.35,
      3,
    );
    expect(result.grade).not.toBe("strong");
    expect(result.fallbackRate).toBeCloseTo(0.667, 2);
  });

  it("counts low-confidence decisions", () => {
    const result = analyzeConfidence(
      [
        { confidence: 0.2, selectedAction: "a" },
        { confidence: 0.9, selectedAction: "b" },
      ],
      0.35,
      2,
    );
    expect(result.lowConfidenceCount).toBe(1);
  });

  it("reports weak when there were no decisions", () => {
    expect(analyzeConfidence([], 0.35, 0).grade).toBe("weak");
  });
});

describe("call analysis", () => {
  const goodCall: ConversationTurn[] = [
    user("hi, where is my order"),
    agent("Your order is out for delivery today.", "order_status"),
    user("perfect, thank you so much"),
    agent("Happy to help!", "greet"),
  ];

  const decisions = [
    { confidence: 0.82, selectedAction: "order_status" },
    { confidence: 0.88, selectedAction: "greet" },
  ];

  it("summarises a good call", () => {
    const result = analyzeCall(session, goodCall, decisions);

    expect(result.sentiment.label).toBe("positive");
    expect(result.confidence.grade).toBe("strong");
    expect(result.escalationRisk).toBe(false);
    expect(result.outcomeScore).toBeGreaterThan(60);
    expect(result.summary).toContain("Resolved");
  });

  it("flags an escalation request", () => {
    const result = analyzeCall(
      session,
      [
        user("I want to speak to a manager"),
        agent("Transferring you", "escalate_supervisor"),
      ],
      [{ confidence: 0.7, selectedAction: "escalate_supervisor" }],
    );

    expect(result.escalationRisk).toBe(true);
  });

  it("detects escalation from an action id alone", () => {
    const result = analyzeCall(
      session,
      [user("fine"), agent("connecting you", "escalate")],
      [{ confidence: 0.7, selectedAction: "escalate" }],
    );
    expect(result.escalationRisk).toBe(true);
  });

  it("treats a caller left mid-sentence as unresolved", () => {
    const result = analyzeCall(
      session,
      [user("my order was wrong and I want"), agent("let me check that", "order_status")],
      [{ confidence: 0.8, selectedAction: "order_status" }],
    );
    expect(result.unresolved).toBe(false);
  });

  it("marks a call that ended on the caller as unresolved", () => {
    const result = analyzeCall(session, [agent("hello", "greet"), user("wait—")], []);
    expect(result.unresolved).toBe(true);
  });

  it("lets an explicit resolver override the heuristic", () => {
    const calls: ConversationTurn[] = [
      user("thanks, that worked"),
      agent("Glad it helped", "greet"),
    ];
    const decisions2 = [{ confidence: 0.9, selectedAction: "greet" }];

    expect(analyzeCall(session, calls, decisions2, { resolve: () => false }).outcomeScore)
      .toBeLessThan(analyzeCall(session, calls, decisions2).outcomeScore);

    expect(analyzeCall(session, calls, decisions2, { resolve: () => true }).resolved).toBe(true);
  });

  it("honours successActions", () => {
    const calls: ConversationTurn[] = [
      user("can I return this"),
      agent("Your refund is started", "refund_request"),
    ];
    const result = analyzeCall(
      session,
      calls,
      [{ confidence: 0.8, selectedAction: "refund_request" }],
      { successActions: ["refund_request"] },
    );
    expect(result.resolved).toBe(true);
  });

  it("breaks down action usage", () => {
    const result = analyzeCall(
      session,
      [
        user("a"),
        agent("x", "greet"),
        user("b"),
        agent("y", "greet"),
        user("c"),
        agent("z", "order_status"),
      ],
      [{ confidence: 0.8, selectedAction: "greet" }],
    );

    expect(result.actionBreakdown[0]).toEqual({ actionId: "greet", count: 2 });
    expect(result.actionBreakdown[1].actionId).toBe("order_status");
  });

  it("keeps the score within 0-100", () => {
    const terrible: ConversationTurn[] = [
      user("this is disgusting and unacceptable, I want a manager"),
      agent("...", "fallback"),
    ];
    const result = analyzeCall(
      session,
      terrible,
      Array.from({ length: 5 }, () => ({ confidence: 0.1, selectedAction: "fallback" })),
    );

    expect(result.outcomeScore).toBeGreaterThanOrEqual(0);
    expect(result.outcomeScore).toBeLessThanOrEqual(100);
    expect(result.outcomeScore).toBeLessThan(40);
  });

  it("records the session and duration", () => {
    const result = analyzeCall(session, goodCall, decisions);
    expect(result.sessionId).toBe("s1");
    expect(result.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(result.turnCount).toBe(4);
  });
});
