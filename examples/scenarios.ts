/**
 * Example regression scenarios.
 *
 * Run with:
 *   npx felona test ./scenarios.ts
 *   npx felona test ./scenarios.ts --verbose
 *
 * The file must export an `agent` and a `scenarios` array. Scenarios are how a
 * change to an action description, a threshold, or the embedding provider gets
 * caught before it silently re-routes a live agent.
 */
import { createAgent, type Scenario } from "felona-voice";

export const agent = createAgent("Acme Support")
  .system("You are a concise, empathetic customer support agent for Acme.")
  .action(
    "greet",
    "Greet the caller warmly and ask how you can help",
    "Hi there, thanks for calling Acme. How can I help you today?",
  )
  .action(
    "order_status",
    "Check the delivery status, tracking number or ETA for an existing order",
    "Your order ACM-9281 is out for delivery today and should arrive by 4:30 PM.",
  )
  .action(
    "refund_request",
    "Process a return, refund, billing dispute or return shipping label",
    "I've started your refund and emailed a prepaid return label.",
  )
  .action(
    "escalate",
    "Escalate to a human supervisor or manager, or handle an angry customer",
    "I apologize for the frustration — I'm connecting you with a senior support lead now.",
  )
  .fallback(
    "Sorry, I didn't catch that. Can you rephrase, or tell me what you'd like help with?",
  )
  .build();

export const scenarios: Scenario[] = [
  {
    name: "greets a caller and offers help",
    turns: [
      {
        say: "hey there",
        expect: { action: "greet", responseContains: "Acme" },
      },
    ],
  },
  {
    name: "routes an order question to order status",
    turns: [
      {
        say: "where is my order",
        expect: {
          action: "order_status",
          responseContains: ["out for delivery", "ACM-9281"],
          confidence: { above: 0.3 },
        },
      },
    ],
  },
  {
    name: "routes a refund request",
    turns: [
      {
        say: "I want to return this and get my money back",
        expect: { action: "refund_request", responseContains: "refund" },
      },
    ],
  },
  {
    name: "escalates a frustrated customer",
    turns: [
      {
        say: "this is completely unacceptable, let me speak to a manager",
        expect: { action: "escalate" },
      },
    ],
  },
  {
    name: "falls back on off-topic speech",
    turns: [
      {
        say: "what is the weather in paris",
        expect: { action: "fallback" },
      },
    ],
  },
  {
    name: "remembers context across turns",
    turns: [
      { say: "where is my order", expect: { action: "order_status" } },
      {
        say: "actually can I get a refund for it instead",
        expect: { action: "refund_request" },
      },
    ],
  },
  {
    name: "stays within the latency budget",
    turns: [
      {
        say: "can you check my delivery",
        expect: { latencyUnderMs: 250 },
      },
    ],
  },
  {
    name: "uses a custom assertion",
    turns: [
      {
        say: "hello",
        assert: (result) => {
          if (!result.candidates.length) {
            throw new Error("expected JEV to report candidate scores");
          }
        },
      },
    ],
  },
];
