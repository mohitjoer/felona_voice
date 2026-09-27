import { describe, it, expect } from "vitest";
import { SlotCollector, createSlotCollector } from "../src/slots/collector.js";
import {
  createCollectTask,
  continueCollectTask,
  getNameTask,
  getEmailTask,
  getCreditCardTask,
  getTaskCollector,
  resetTaskCollector,
} from "../src/slots/tasks.js";
import { ConversationMemory } from "../src/memory/context.js";
import type { ActionContext } from "../src/types.js";

/** Minimal ActionContext for exercising task handlers directly. */
function ctxWithMemory(): ActionContext {
  return {
    conversation: {
      session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
      turns: [],
      currentUtterance: "",
      slots: {},
      systemPrompt: "",
    },
    tools: { call: async () => undefined, list: () => [] },
    memory: new ConversationMemory(),
    session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
  };
}

describe("SlotCollector", () => {
  it("prompts for the first required slot and completes when filled", () => {
    const collector = createSlotCollector([
      { name: "name", type: "name" },
      { name: "zip", type: "zip" },
    ]);

    expect(collector.nextPrompt()).toContain("name");
    expect(collector.complete).toBe(false);
    expect(collector.missing).toEqual(["name", "zip"]);

    collector.ingest("my name is Jane Doe");
    expect(collector.slots.name).toBe("Jane Doe");
    expect(collector.complete).toBe(false);
    expect(collector.missing).toEqual(["zip"]);

    collector.ingest("my zip is 94103");
    expect(collector.slots.zip).toBe("94103");
    expect(collector.complete).toBe(true);
    expect(collector.nextPrompt()).toBeNull();
  });

  it("fills out-of-order answers", () => {
    const collector = createSlotCollector([
      { name: "name", type: "name" },
      { name: "email", type: "email" },
    ]);

    collector.ingest("my email is jane at gmail dot com");
    expect(collector.slots.email).toBe("jane@gmail.com");
    expect(collector.slots.name).toBeUndefined();
  });

  it("does not consume an attempt when nothing is extracted", () => {
    const collector = createSlotCollector([{ name: "email", type: "email", maxAttempts: 2 }]);

    const result = collector.ingest("I want to complain about my order");
    expect(result.rejected).toHaveLength(0);
    expect(result.filled).toHaveLength(0);
    // Still asking, and no attempt burned on unrelated speech.
    expect(result.prompt).toContain("email");
    expect(collector.state[0].attempts).toBe(0);
  });

  it("re-prompts after a value fails validation, then gives up", () => {
    // A validator that always rejects isolates the collector's re-prompt and
    // abandonment logic from any particular extractor's behaviour.
    const collector = createSlotCollector([
      {
        name: "email",
        type: "email",
        maxAttempts: 2,
        validate: () => ({ valid: false, message: "That address bounced." }),
      },
    ]);

    let result = collector.ingest("jane at gmail dot com");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].message).toBe("That address bounced.");
    expect(result.prompt).toContain("email");

    result = collector.ingest("jane2 at gmail dot com");
    expect(result.rejected).toHaveLength(1);

    // Attempts exhausted: it stops asking rather than looping forever.
    expect(collector.nextPrompt()).toBeNull();
    expect(collector.state[0].abandoned).toBe(true);
  });

  it("does not attempt a filled slot again", () => {
    const collector = createSlotCollector([{ name: "zip", type: "zip" }]);
    collector.ingest("94103");
    collector.ingest("90210");

    expect(collector.slots.zip).toBe("94103");
  });

  it("skips optional slots when completing", () => {
    const collector = createSlotCollector([
      { name: "name", type: "name" },
      { name: "company", type: "string", required: false },
    ]);

    collector.ingest("my name is Jane");
    expect(collector.complete).toBe(true);
  });

  it("seeds a known value and validates it", () => {
    const collector = createSlotCollector([{ name: "email", type: "email" }]);

    expect(collector.seed("email", "jane@example.com")).toBe(true);
    expect(collector.slots.email).toBe("jane@example.com");

    const other = createSlotCollector([{ name: "zip", type: "zip" }]);
    expect(other.seed("zip", "not-a-zip")).toBe(false);
  });

  it("honours shouldAttempt to avoid false matches", () => {
    const collector = createSlotCollector([
      {
        name: "order_id",
        type: "number",
        // A 5-digit order number must not be swallowed as a ZIP.
        shouldAttempt: (text) => /order/i.test(text),
      },
      { name: "zip", type: "zip" },
    ]);

    collector.ingest("my zip is 94103");
    expect(collector.slots.zip).toBe("94103");
    expect(collector.slots.order_id).toBeUndefined();
  });

  it("reset clears collected state", () => {
    const collector = createSlotCollector([{ name: "name", type: "name" }]);
    collector.ingest("my name is Jane");
    collector.reset();

    expect(collector.slots).toEqual({});
    expect(collector.complete).toBe(false);
  });

  it("rejects a duplicate slot name and an empty definition list", () => {
    expect(
      () =>
        new SlotCollector([
          { name: "a", type: "string" },
          { name: "a", type: "string" },
        ]),
    ).toThrow(/Duplicate/);

    expect(() => new SlotCollector([])).toThrow(/at least one/);
  });
});

describe("collect tasks", () => {
  it("opens the flow with a prompt", async () => {
    const task = getEmailTask();
    const reply = await task.handler(ctxWithMemory());

    expect(reply).toContain("email");
    expect(task.id).toBe("get_email");
  });

  it("keeps collector state on the session across turns", async () => {
    const task = getEmailTask();
    const ctx = ctxWithMemory();

    const opening = await task.handler(ctx);
    expect(opening).toContain("email");

    // The collector must be reachable by the task id for continuation.
    const collector = getTaskCollector(ctx, "get_email");
    expect(collector).toBeDefined();

    const next = continueCollectTask(
      { slots: [{ name: "email", type: "email" }] },
      collector!,
      "jane dot doe at gmail dot com",
    );

    expect(next.toLowerCase()).toContain("thank");
    expect(collector!.slots.email).toBe("jane.doe@gmail.com");
  });

  it("does not share collector state between sessions", async () => {
    const task = getEmailTask();
    const ctxA = ctxWithMemory();
    const ctxB = ctxWithMemory();

    await task.handler(ctxA);
    await task.handler(ctxB);

    const a = getTaskCollector(ctxA, "get_email")!;
    const b = getTaskCollector(ctxB, "get_email")!;

    a.ingest("jane at gmail dot com");

    expect(a.slots.email).toBe("jane@gmail.com");
    expect(b.slots.email).toBeUndefined();
  });

  it("resetTaskCollector clears progress", async () => {
    const task = getEmailTask();
    const ctx = ctxWithMemory();
    await task.handler(ctx);

    const collector = getTaskCollector(ctx, "get_email")!;
    collector.ingest("jane at gmail dot com");
    expect(collector.slots.email).toBe("jane@gmail.com");

    resetTaskCollector(ctx, "get_email");
    expect(collector.slots).toEqual({});
  });

  it("walks a card through all three fields", async () => {
    const task = getCreditCardTask();
    const ctx = ctxWithMemory();
    await task.handler(ctx);
    const collector = getTaskCollector(ctx, "get_credit_card")!;
    const opts = { slots: [] as never[] };

    let reply = continueCollectTask(
      opts,
      collector,
      "four five three nine five seven eight seven six three six two one four eight six",
    );
    // The card number must not also satisfy the expiry or CVV slots.
    expect(reply.toLowerCase()).toContain("expiration");

    reply = continueCollectTask(opts, collector, "march 2027");
    expect(reply.toLowerCase()).toContain("security");

    reply = continueCollectTask(opts, collector, "four one two");
    expect(reply.toLowerCase()).toContain("thank");

    expect(collector.complete).toBe(true);
    expect(collector.slots.cardNumber).toBe("4539578763621486");
    expect(collector.slots.expiry).toBe("0327");
    expect(collector.slots.cvv).toBe("412");
  });

  it("re-asks when a card number fails the checksum", async () => {
    const task = getCreditCardTask();
    const ctx = ctxWithMemory();
    await task.handler(ctx);
    const collector = getTaskCollector(ctx, "get_credit_card")!;

    // One digit misheard: the Luhn check should catch it and re-ask.
    const reply = continueCollectTask(
      { slots: [] },
      collector,
      "four five three nine five seven eight seven six three six two one four eight seven",
    );

    expect(reply.toLowerCase()).toContain("did not check out");
    expect(collector.complete).toBe(false);
  });

  it("uses custom completion wording", async () => {
    const options = {
      id: "confirm_order",
      slots: [{ name: "order_id", type: "number" as const }],
      onComplete: (slots: Record<string, unknown>) => `Order ${slots.order_id} confirmed.`,
      greeting: "Happy to help.",
    };
    const task = createCollectTask(options);

    const ctx = ctxWithMemory();
    const opening = await task.handler(ctx);
    expect(opening).toContain("Happy to help.");

    const collector = getTaskCollector(ctx, "confirm_order")!;
    const reply = continueCollectTask(options, collector, "my order number is 4821");
    expect(reply).toBe("Order 4821 confirmed.");
  });

  it("requires at least one slot", () => {
    expect(() => createCollectTask({ slots: [] })).toThrow(/at least one/);
  });
});

describe("slot collection through the agent", () => {
  it("routes to the collect task and fills slots across turns", async () => {
    const { createAgent } = await import("../src/builder.js");
    const { getTaskCollector } = await import("../src/slots/tasks.js");

    const agent = createAgent("Checkout")
      .system("You take orders over the phone.")
      .action("greet", "Greet the caller and ask how you can help", "Hello, how can I help?")
      .action(
        "order_help",
        "Help with an existing order, tracking or delivery status",
        "Let me look up your order.",
      )
      .collect({
        id: "take_details",
        description: "Collect the caller's name, email and ZIP code to process the request",
        slots: [
          { name: "name", type: "name" },
          { name: "email", type: "email" },
          { name: "zip", type: "zip" },
        ],
        onComplete: (s) => `Thanks ${s.name}, we sent a confirmation to ${s.email}.`,
      })
      .fallback("Sorry, could you say that again?")
      .build();

    // An opening line naming the fields routes to the collection task.
    const opening = await agent.interact(
      "I would like to give you my name email and zip code",
    );
    expect(opening.action.id).toBe("take_details");
    expect(opening.text.toLowerCase()).toContain("name");

    // The collector lives on the session's memory, reachable publicly.
    const ctx = {
      conversation: {
        session: { id: "x", startedAt: new Date(), metadata: {}, state: "active" },
        turns: [],
        currentUtterance: "",
        slots: {},
        systemPrompt: "",
      },
      tools: { call: async () => undefined, list: () => [] },
      memory: agent.memory,
      session: { id: "x", startedAt: new Date(), metadata: {}, state: "active" },
    } as unknown as ActionContext;

    const collector = getTaskCollector(ctx, "take_details");
    expect(collector).toBeDefined();

    collector!.ingest("my name is Jane Doe");
    expect(collector!.slots.name).toBe("Jane Doe");

    // Unrelated speech must not be captured as a value.
    collector!.ingest("I was calling about the weather earlier");
    expect(collector!.slots.zip).toBeUndefined();
    expect(collector!.slots.email).toBeUndefined();

    collector!.ingest("jane dot doe at gmail dot com");
    expect(collector!.slots.email).toBe("jane.doe@gmail.com");

    collector!.ingest("my zip is 94103");
    expect(collector!.complete).toBe(true);
    expect(collector!.slots.zip).toBe("94103");
  });
});
