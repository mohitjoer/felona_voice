import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DecisionRequestError,
  SystemOneDecisionProvider,
  createDecisionProvider,
  assertDecisionRequest,
} from "../src/jev/decision-provider.js";
import { JEVEngine } from "../src/jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../src/jev/fast-embeddings.js";
import { FelAgent, createAgent } from "../src/index.js";
import type {
  AgentAction,
  ConversationContext,
  DecisionAnswers,
  DecisionProvider,
  DecisionProviderConfig,
  DecisionQuestion,
  DecisionResult,
  Session,
} from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Captures the request the provider built and replies with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return calls;
}

const choiceAnswer = (choice: string, probabilities: Record<string, number>) => ({
  answers: {
    route: { type: "choice", choice, probabilities, confidence: 0.8 },
  },
  model: "test-model-1",
  usage: { input_tokens: 120, output_tokens: 8 },
});

// ─── Request validation ─────────────────────────────────────────────────────

describe("assertDecisionRequest", () => {
  const choice = (criteria: Record<string, string | null>): DecisionQuestion => ({
    type: "choice",
    instructions: "Which one?",
    criteria,
  });

  it("rejects an empty state", () => {
    expect(() => assertDecisionRequest("   ", { q: choice({ a: null, b: null }) })).toThrow(
      /non-empty state/,
    );
  });

  it("rejects a request with no questions", () => {
    expect(() => assertDecisionRequest("hello", {})).toThrow(/at least one question/);
  });

  it("rejects a question with no instructions", () => {
    // The question id is never sent to the model, so a question with no
    // instructions is a request with no question in it.
    expect(() =>
      assertDecisionRequest("hello", { q: { type: "noul", instructions: "" } }),
    ).toThrow(/instructions/);
  });

  it("rejects a choice with fewer than two options", () => {
    expect(() => assertDecisionRequest("hello", { q: choice({ only: null }) })).toThrow(
      /at least two/,
    );
  });

  it("rejects a choice over the option cap", () => {
    const many: Record<string, string | null> = {};
    for (let i = 0; i < 256; i++) many[`opt_${i}`] = null;

    expect(() => assertDecisionRequest("hello", { q: choice(many) })).toThrow(
      /over the 255/,
    );
  });

  it("rejects an undescribed score level", () => {
    expect(() =>
      assertDecisionRequest("hello", {
        q: { type: "score", instructions: "How bad?", criteria: ["fine", "  "] },
      }),
    ).toThrow(/level 1 has no description/);
  });

  it("accepts a well-formed request", () => {
    expect(() =>
      assertDecisionRequest("hello", {
        q: choice({ a: "first", b: "second" }),
        s: { type: "score", instructions: "How bad?", criteria: ["ok", "terrible"] },
        n: { type: "noul", instructions: "Refund?" },
      }),
    ).not.toThrow();
  });
});

// ─── Request shape ──────────────────────────────────────────────────────────

describe("SystemOneDecisionProvider request", () => {
  it("posts state, model and questions to /v1/systemone", async () => {
    const calls = stubFetch(choiceAnswer("a", { a: 0.9, b: 0.1 }));

    await createDecisionProvider({ apiKey: "sk-test", model: "jev-1.13.0" }).decide(
      "I was charged twice",
      { route: { type: "choice", instructions: "Which team?", criteria: { a: "Alpha", b: "Beta" } } },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.state).toBe("I was charged twice");
    expect(body.model).toBe("jev-1.13.0");
    expect(Object.keys(body.questions)).toEqual(["route"]);
    expect(body.questions.route.criteria).toEqual({ a: "Alpha", b: "Beta" });
  });

  it("sends a bearer token only when one is configured", async () => {
    const withKey = stubFetch(choiceAnswer("a", { a: 1, b: 0 }));
    await createDecisionProvider({ apiKey: "sk-test" }).decide("hi", {
      route: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    });
    const authed = (withKey[0].init.headers as Record<string, string>).Authorization;
    expect(authed).toBe("Bearer sk-test");

    const withoutKey = stubFetch(choiceAnswer("a", { a: 1, b: 0 }));
    await createDecisionProvider({ baseUrl: "http://127.0.0.1:8009" }).decide("hi", {
      route: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    });
    expect((withoutKey[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("honours a custom baseUrl without a trailing-slash artifact", async () => {
    const calls = stubFetch(choiceAnswer("a", { a: 1, b: 0 }));
    await createDecisionProvider({ baseUrl: "http://localhost:8009/" }).decide("hi", {
      route: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    });
    expect(calls[0].url).toBe("http://localhost:8009/v1/systemone");
  });

  it("merges custom headers", async () => {
    const calls = stubFetch(choiceAnswer("a", { a: 1, b: 0 }));
    await createDecisionProvider({ headers: { "X-Tenant": "acme" } }).decide("hi", {
      route: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    });
    expect((calls[0].init.headers as Record<string, string>)["X-Tenant"]).toBe("acme");
  });
});

// ─── Response parsing ───────────────────────────────────────────────────────

describe("SystemOneDecisionProvider response", () => {
  const ask = (body: unknown, provider = createDecisionProvider()) =>
    provider.decide("hello", {
      route: { type: "choice", instructions: "?", criteria: { a: "Alpha", b: "Beta" } },
    }) as Promise<DecisionResult>;

  it("parses choice answers with probabilities and usage", async () => {
    stubFetch(choiceAnswer("a", { a: 0.8, b: 0.2 }));

    const result = await ask(null);

    expect(result.answers.route.choice).toBe("a");
    expect(result.answers.route.probabilities).toEqual({ a: 0.8, b: 0.2 });
    expect(result.answers.route.confidence).toBe(0.8);
    expect(result.model).toBe("test-model-1");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });

  it("falls back to certainty on the choice when no distribution is returned", async () => {
    // A server that returns only the label must still yield a usable score for
    // the fallback threshold rather than a silent zero.
    stubFetch({ answers: { route: { type: "choice", choice: "a" } } });

    const result = await ask(null);
    expect(result.answers.route.probabilities).toEqual({ a: 1, b: 0 });
  });

  it("rejects a choice that was never offered", async () => {
    // Accepting this would route to an action that does not exist.
    stubFetch(choiceAnswer("nonexistent", { a: 0.5, b: 0.5 }));

    await expect(ask(null)).rejects.toThrow(/was not one of the offered options/);
  });

  it("rejects a response missing an answer that was asked for", async () => {
    stubFetch({ answers: { other: { choice: "a" } } });

    await expect(ask(null)).rejects.toThrow(/did not answer question "route"/);
  });

  it("rejects a response with no answers object", async () => {
    stubFetch({ model: "test-model-1" });

    await expect(ask(null)).rejects.toThrow(/no "answers" object/);
  });

  it("rejects a probability outside 0–1", async () => {
    stubFetch(choiceAnswer("a", { a: 1.4, b: -0.4 }));

    await expect(ask(null)).rejects.toThrow(/outside 0–1/);
  });

  it("parses a noul answer", async () => {
    stubFetch({ answers: { urgent: { type: "noul", noul: 0.93 } } });

    const result = await createDecisionProvider().decide("help me now", {
      urgent: { type: "noul", instructions: "Is this urgent?" },
    });

    expect(result.answers.urgent.noul).toBe(0.93);
    // A noul near 0.5 means yes and no are equally likely, not medium intensity.
    expect(result.answers.urgent.confidence).toBeCloseTo(0.93);
  });

  it("parses a score answer with a legend", async () => {
    stubFetch({
      answers: {
        mood: {
          type: "score",
          score: 1.44,
          legend: { "0": "Calm", "1": "Frustrated", "2": "Angry" },
          probabilities: { "0": 0.05, "1": 0.5, "2": 0.45 },
        },
      },
    });

    const result = await createDecisionProvider().decide("this is ridiculous", {
      mood: { type: "score", instructions: "How angry?", criteria: ["Calm", "Frustrated", "Angry"] },
    });

    expect(result.answers.mood.score).toBe(1.44);
    expect(result.answers.mood.legend).toEqual({
      "0": "Calm",
      "1": "Frustrated",
      "2": "Angry",
    });
  });

  it("derives a score from probabilities when none is reported", async () => {
    stubFetch({
      answers: { mood: { type: "score", probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } } },
    });

    const result = await createDecisionProvider().decide("furious", {
      mood: { type: "score", instructions: "How angry?", criteria: ["Calm", "Frustrated", "Angry"] },
    });

    expect(result.answers.mood.score).toBeCloseTo(1.6);
  });

  it("surfaces a non-2xx status with the server's message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("too many options", { status: 413, statusText: "Payload Too Large" }),
    ) as unknown as typeof fetch;

    await expect(ask(null)).rejects.toThrow(/413.*too many options/);
  });

  it("exposes the status on DecisionRequestError", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 422, statusText: "Unprocessable" }),
    ) as unknown as typeof fetch;

    await expect(ask(null)).rejects.toBeInstanceOf(DecisionRequestError);
    await ask(null).catch((error: DecisionRequestError) => {
      expect(error.status).toBe(422);
    });
  });

  it("retries a retryable status and then gives up with the last error", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return new Response("busy", { status: 503, statusText: "Unavailable" });
    }) as unknown as typeof fetch;

    await expect(ask(null, createDecisionProvider({ timeoutMs: 5000 }))).rejects.toThrow(/503/);
    expect(attempts).toBeGreaterThan(1);
  }, 10_000);

  it("does not retry a 422", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      return new Response("bad", { status: 422, statusText: "Unprocessable" });
    }) as unknown as typeof fetch;

    await expect(ask(null)).rejects.toThrow(/422/);
    expect(attempts).toBe(1);
  });

  it("rejects a caller abort without retrying it", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await expect(
      createDecisionProvider().decide(
        "hello",
        { route: { type: "choice", instructions: "?", criteria: { a: null, b: null } } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(0);
  });
});

// ─── Engine integration ─────────────────────────────────────────────────────

/** A decision provider whose answers the test dictates. */
class StubDecisionProvider implements DecisionProvider {
  readonly name = "stub";
  readonly states: string[] = [];
  readonly questions: Array<Record<string, DecisionQuestion>> = [];

  constructor(
    private readonly answers: Record<string, DecisionAnswers>,
    private readonly fail?: Error,
  ) {}

  async decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionResult> {
    this.states.push(state);
    this.questions.push(questions);
    if (this.fail) throw this.fail;
    return { answers: this.answers };
  }
}

const actions: AgentAction[] = [
  { id: "order_status", description: "Check delivery status and tracking for an order", handler: async () => "" },
  { id: "refund", description: "Process a refund, return or billing dispute", handler: async () => "" },
  { id: "escalate", description: "Escalate the call to a human supervisor", handler: async () => "" },
  { id: "fallback", description: "Anything unrecognized or off-topic", handler: async () => "" },
];

const contextFor = (text: string, turns: ConversationContext["turns"] = []): ConversationContext => ({
  session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" } as Session,
  turns,
  currentUtterance: text,
  slots: {},
  systemPrompt: "You are a support agent.",
});

const engineFor = async (decisionProvider?: DecisionProvider, onDecisionError?: "fallback" | "throw") => {
  const engine = new JEVEngine({
    embeddingProvider: new FastSemanticEmbeddingProvider(),
    decisionProvider,
    onDecisionError,
  });
  await engine.initialize(actions);
  return engine;
};

describe("JEVEngine with a decision provider", () => {
  it("routes on the returned distribution", async () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
        confidence: 0.85,
      },
    });
    const engine = await engineFor(provider);

    const match = await engine.decide(contextFor("you charged me twice"));

    expect(match.action.id).toBe("refund");
    expect(match.confidence).toBe(0.85);
    expect(match.candidates[0]).toEqual({ actionId: "refund", score: 0.9 });
    expect(match.candidates).toHaveLength(4);
  });

  it("sends the action space as one choice question keyed by action id", async () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
        confidence: 0.85,
      },
    });
    const engine = await engineFor(provider);

    await engine.decide(contextFor("charged twice"));

    const sent = provider.questions[0];
    expect(Object.keys(sent)).toEqual(["route"]);
    expect(sent.route.type).toBe("choice");
    expect(sent.route.type === "choice" && sent.route.criteria).toEqual({
      order_status: "Check delivery status and tracking for an order",
      refund: "Process a refund, return or billing dispute",
      escalate: "Escalate the call to a human supervisor",
      fallback: "Anything unrecognized or off-topic",
    });
  });

  it("reports the decision backend rather than the embedder", async () => {
    const local = await engineFor();
    expect(local.usesDecisionProvider).toBe(false);
    expect(local.routingBackend).toBe(local.providerName);

    const remote = await engineFor(
      new StubDecisionProvider({
        route: {
          choice: "refund",
          probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
          confidence: 0.85,
        },
      }),
    );
    expect(remote.usesDecisionProvider).toBe(true);
    expect(remote.routingBackend).toBe("stub");
  });

  it("puts the live utterance last so a topic change can win", async () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "escalate",
        probabilities: { order_status: 0.02, refund: 0.03, escalate: 0.9, fallback: 0.05 },
        confidence: 0.9,
      },
    });
    const engine = await engineFor(provider);

    await engine.decide(
      contextFor("get me a supervisor", [
        { role: "user", content: "where is my order", timestampMs: 1 },
        { role: "agent", content: "It shipped Tuesday.", timestampMs: 2, actionId: "order_status" },
      ]),
    );

    const state = provider.states[0];
    expect(state).toContain("where is my order");
    // The agent's own reply is not evidence of what the caller wants next.
    expect(state).not.toContain("It shipped Tuesday.");
    expect(state.endsWith("The caller just said: get me a supervisor")).toBe(true);
  });

  it("routes a weak decision to fallback", async () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.1, refund: 0.12, escalate: 0.1, fallback: 0.68 },
        confidence: 0.12,
      },
    });
    const engine = await engineFor(provider);

    const match = await engine.decide(contextFor("hmm"));
    expect(match.action.id).toBe("fallback");
  });

  it("falls back when the provider throws, keeping the call alive", async () => {
    const provider = new StubDecisionProvider({}, new Error("connection refused"));
    const engine = await engineFor(provider);

    const match = await engine.decide(contextFor("hello"));
    expect(match.action.id).toBe("fallback");
    expect(match.confidence).toBe(0);
  });

  it("throws on provider failure when configured to", async () => {
    const provider = new StubDecisionProvider({}, new Error("connection refused"));
    const engine = await engineFor(provider, "throw");

    await expect(engine.decide(contextFor("hello"))).rejects.toThrow(/connection refused/);
  });

  it("propagates a barge-in abort instead of speaking a fallback", async () => {
    // The caller interrupted on purpose; answering anyway would speak a reply
    // nobody asked for.
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const engine = await engineFor(new StubDecisionProvider({}, abort));

    await expect(engine.decide(contextFor("hello"))).rejects.toThrow(/aborted/);
  });

  it("throws rather than inventing a match when the chosen action is unknown", async () => {
    // A contract violation, not an outage: degrading it to a fallback reply
    // would hide the bug behind a plausible-sounding answer.
    const provider = new StubDecisionProvider({
      route: {
        choice: "does_not_exist",
        probabilities: { order_status: 0.1, refund: 0.1, escalate: 0.1, fallback: 0.7 },
        confidence: 0.7,
      },
    });
    const engine = await engineFor(provider);

    await expect(engine.decide(contextFor("hello"))).rejects.toThrow(/not registered/);
  });

  it("throws on a missing answer rather than routing without one", async () => {
    const engine = await engineFor(new StubDecisionProvider({}));

    await expect(engine.decide(contextFor("hello"))).rejects.toThrow(/without choosing/);
  });

  it("uses the reported probability when no confidence is supplied", async () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
      },
    });
    const engine = await engineFor(provider);

    const match = await engine.decide(contextFor("charged twice"));
    expect(match.confidence).toBe(0.9);
  });

  it("keeps local routing as the default", async () => {
    const engine = await engineFor();
    const match = await engine.decide(contextFor("where is my order"));
    expect(match.action.id).toBe("order_status");
  });
});
// ─── Agent configuration ────────────────────────────────────────────────────

describe("agent decision configuration", () => {
  const build = (decision?: DecisionProviderConfig) =>
    new FelAgent({
      name: "Support",
      actions,
      jev: { decision },
    });

  it("keeps local routing when no decision backend is configured", () => {
    const agent = build();
    expect(agent.jevEngine.usesDecisionProvider).toBe(false);
  });

  it("accepts a provider instance", () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
        confidence: 0.9,
      },
    });

    const agent = build({ provider });
    expect(agent.jevEngine.usesDecisionProvider).toBe(true);
    expect(agent.jevEngine.routingBackend).toBe("stub");
  });

  it("accepts the systemone name against a local server without a key", () => {
    const agent = build({ provider: "systemone", baseUrl: "http://127.0.0.1:8009" });
    expect(agent.jevEngine.routingBackend).toBe("systemone");
  });

  it("rejects an unknown provider name at construction", () => {
    // A typo must be a startup error, not a call that quietly keeps routing
    // locally because the name did not match.
    expect(() => build({ provider: "systemonee" })).toThrow(/Unknown jev.decision.provider/);
  });

  it("rejects a hosted endpoint with no apiKey", () => {
    // Otherwise the first live turn fails 401, after the caller is connected.
    expect(() => build({ provider: "systemone" })).toThrow(/no apiKey/);
  });
});

describe("builder .decision()", () => {
  it("reaches the agent through build()", () => {
    const provider = new StubDecisionProvider({
      route: {
        choice: "refund",
        probabilities: { order_status: 0.05, refund: 0.9, escalate: 0.03, fallback: 0.02 },
        confidence: 0.9,
      },
    });

    const agent = createAgent("Support")
      .action("order_status", "Check delivery status and tracking for an order", async () => "")
      .action("refund", "Process a refund, return or billing dispute", async () => "")
      .action("fallback", "Anything unrecognized or off-topic", async () => "")
      .decision({ provider })
      .build();

    expect(agent.jevEngine.usesDecisionProvider).toBe(true);
    expect(agent.jevEngine.routingBackend).toBe("stub");
  });
});
