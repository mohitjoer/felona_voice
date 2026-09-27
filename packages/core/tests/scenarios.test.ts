import { describe, it, expect, vi } from "vitest";
import {
  runScenario,
  runScenarios,
  formatScenarioReport,
} from "../src/testing/scenarios.js";
import { createAgent } from "../src/builder.js";
import type { Scenario } from "../src/testing/scenarios.js";

function supportAgent() {
  return createAgent("Acme Support")
    .system("You are a concise support agent.")
    .action("greet", "Greet the caller and ask how you can help", "Hi, how can I help?")
    .action(
      "order_status",
      "Check delivery status or tracking for an existing order",
      "Your order is out for delivery today.",
    )
    .action(
      "refund_request",
      "Process a return or refund for a purchase",
      "Your refund has been initiated.",
    )
    .fallback("Sorry, I did not catch that.")
    .build();
}

const silent = { log: () => {} };

describe("scenario harness", () => {
  it("passes a scenario whose expectations hold", async () => {
    const scenario: Scenario = {
      name: "routes an order question",
      turns: [
        {
          say: "where is my order",
          expect: { action: "order_status", responseContains: "out for delivery" },
        },
      ],
    };

    const result = await runScenario(supportAgent(), scenario);
    expect(result.passed).toBe(true);
    expect(result.turns[0].action).toBe("order_status");
  });

  it("fails with a readable message when the action is wrong", async () => {
    const scenario: Scenario = {
      name: "wrong expectation",
      turns: [{ say: "where is my order", expect: { action: "greet" } }],
    };

    const result = await runScenario(supportAgent(), scenario);
    expect(result.passed).toBe(false);
    expect(result.turns[0].failures[0]).toContain('expected action "greet"');
    expect(result.turns[0].failures[0]).toContain('got "order_status"');
  });

  it("checks response contents, patterns and exclusions", async () => {
    const agent = supportAgent();

    const ok = await runScenario(agent, {
      name: "contents",
      turns: [
        {
          say: "where is my order",
          expect: {
            responseContains: ["out for", "delivery"],
            responseMatches: /order/i,
            responseExcludes: "refund",
          },
        },
      ],
    });
    expect(ok.passed).toBe(true);

    const bad = await runScenario(agent, {
      name: "exclusion violated",
      turns: [
        {
          say: "I want a refund",
          expect: { action: "refund_request", responseExcludes: "refund" },
        },
      ],
    });
    expect(bad.passed).toBe(false);
    expect(bad.turns[0].failures[0]).toContain("unexpectedly contained");
  });

  it("checks confidence bounds", async () => {
    const result = await runScenario(supportAgent(), {
      name: "confidence floor",
      turns: [
        {
          say: "where is my order",
          expect: { confidence: { above: 0.99 } },
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.turns[0].failures[0]).toContain("below the expected minimum");
  });

  it("enforces a latency budget", async () => {
    const result = await runScenario(supportAgent(), {
      name: "latency",
      // A budget no in-process decision can meet.
      turns: [{ say: "hello", expect: { latencyUnderMs: 0.0001 } }],
    });

    expect(result.passed).toBe(false);
    expect(result.turns[0].failures[0]).toContain("over the");
  });

  it("supports a custom assertion", async () => {
    const good = await runScenario(supportAgent(), {
      name: "custom ok",
      turns: [
        {
          say: "hello",
          assert: (r) => {
            if (r.candidates.length === 0) throw new Error("no candidates");
          },
        },
      ],
    });
    expect(good.passed).toBe(true);

    const bad = await runScenario(supportAgent(), {
      name: "custom throws",
      turns: [{ say: "hello", assert: () => { throw new Error("boom"); } }],
    });
    expect(bad.passed).toBe(false);
    expect(bad.turns[0].failures[0]).toContain("boom");
  });

  it("isolates sessions by default so scenarios are order-independent", async () => {
    const agent = supportAgent();

    // Prime the shared session with context.
    await agent.interact({ userMessage: "I want a refund", sessionId: "scenario:shared" });

    const result = await runScenario(agent, {
      name: "shared",
      sessionId: "scenario:shared",
      turns: [{ say: "where is my order", expect: { action: "order_status" } }],
    });

    // A fresh session must not inherit the refund context.
    expect(result.passed).toBe(true);
  });

  it("reports an empty scenario rather than passing it silently", async () => {
    const result = await runScenario(supportAgent(), { name: "empty", turns: [] });
    expect(result.passed).toBe(false);
    expect(result.error).toContain("no turns");
  });

  it("keeps running after a failure so every break is reported at once", async () => {
    const report = await runScenarios(
      supportAgent(),
      [
        { name: "fails", turns: [{ say: "where is my order", expect: { action: "greet" } }] },
        { name: "passes", turns: [{ say: "where is my order", expect: { action: "order_status" } }] },
      ],
      silent,
    );

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });

  it("stops early with bail", async () => {
    const report = await runScenarios(
      supportAgent(),
      [
        { name: "fails", turns: [{ say: "hi", expect: { action: "nope" } }] },
        { name: "never runs", turns: [{ say: "hi", expect: { action: "greet" } }] },
      ],
      { ...silent, bail: true },
    );

    expect(report.total).toBe(1);
  });

  it("treats an agent exception as a scenario failure, not a crash", async () => {
    const agent = supportAgent();
    vi.spyOn(agent, "interact").mockRejectedValueOnce(new Error("provider down"));

    const report = await runScenarios(
      agent,
      [{ name: "throws", turns: [{ say: "hello" }] }],
      silent,
    );

    expect(report.failed).toBe(1);
    expect(report.scenarios[0].turns[0].failures[0]).toContain("provider down");
    vi.restoreAllMocks();
  });

  it("formats a report that names the failing turn", async () => {
    const report = await runScenarios(
      supportAgent(),
      [{ name: "broken", turns: [{ say: "where is my order", expect: { action: "greet" } }] }],
      silent,
    );

    const text = formatScenarioReport(report);
    expect(text).toContain("❌");
    expect(text).toContain("0/1 passed");
    expect(text).toContain("broken");
    expect(text).toContain("where is my order");
  });

  it("formats a clean report", async () => {
    const report = await runScenarios(
      supportAgent(),
      [{ name: "ok", turns: [{ say: "hi", expect: { action: "greet" } }] }],
      silent,
    );

    const text = formatScenarioReport(report);
    expect(text).toContain("✅");
    expect(text).toContain("1/1 passed");
  });
});
