/**
 * Customer Support Agent — Multi-action agent with tool calling.
 *
 * This example creates a support agent for "Acme Corp" with:
 * - Multiple JEV-driven actions (greet, troubleshoot, lookup, escalate, close)
 * - Tool calling (order lookup, ticket creation)
 * - Slot extraction (order number, customer name)
 *
 * JEV dynamically predicts the right action based on conversation context.
 */
import { FelAgent, defineAction, defineTool } from "felona-voice";

// ─── Tools ──────────────────────────────────────────────────────────────────

const lookupOrderTool = defineTool({
  name: "lookup_order",
  description: "Look up an order by order number",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order ID to look up" },
    },
    required: ["orderId"],
  },
  execute: async (params) => {
    // Simulated order lookup
    const orderId = params.orderId as string;
    return {
      orderId,
      status: "shipped",
      estimatedDelivery: "2026-09-25",
      items: ["Widget Pro", "Widget Case"],
      trackingNumber: "1Z999AA10123456784",
    };
  },
});

const createTicketTool = defineTool({
  name: "create_ticket",
  description: "Create a support ticket for the customer",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string" },
      description: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["subject", "description"],
  },
  execute: async (params) => {
    return {
      ticketId: `TICKET-${Date.now()}`,
      status: "created",
      subject: params.subject,
    };
  },
});

// ─── Agent ──────────────────────────────────────────────────────────────────

const agent = new FelAgent({
  name: "Acme Support",
  systemPrompt: `You are a customer support agent for Acme Corp, a technology company.
You are professional, empathetic, and solution-oriented.
Keep responses concise — you're on a voice call.
If you need to look up an order, ask for the order number first.
Always confirm actions before taking them.`,

  stt: {
    provider: "deepgram",
    apiKey: process.env.DEEPGRAM_API_KEY!,
  },
  tts: {
    provider: "elevenlabs",
    apiKey: process.env.ELEVEN_API_KEY!,
  },

  tools: [lookupOrderTool, createTicketTool],

  actions: [
    defineAction({
      id: "greet",
      description:
        "Greet the customer and ask how you can help. Use at the start of the conversation.",
      handler: async () => {
        return "Hello, thank you for calling Acme Corp support. My name is Alex. How can I assist you with your order or device today?";
      },
    }),

    defineAction({
      id: "troubleshoot",
      description:
        "Help the customer troubleshoot a technical issue. Ask clarifying questions to understand the problem.",
      handler: async () => {
        return "I can help troubleshoot that issue. First, please ensure the power cable is securely connected and check if the indicator LED is flashing blue.";
      },
    }),

    defineAction({
      id: "lookup_order",
      description:
        "Look up an order status for the customer. Use when they ask about their order, delivery, or tracking.",
      handler: async (ctx) => {
        const utterance = ctx.conversation.currentUtterance;
        const orderIdMatch = utterance.match(/\b\d{5,}\b/);

        if (orderIdMatch) {
          const result = (await ctx.tools.call("lookup_order", {
            orderId: orderIdMatch[0],
          })) as { status: string; estimatedDelivery: string };
          ctx.memory.setSlot("orderId", orderIdMatch[0]);
          ctx.memory.setSlot("orderStatus", result.status);

          return `Order ${orderIdMatch[0]} is currently ${result.status} and scheduled for delivery on ${result.estimatedDelivery}.`;
        } else {
          return "I'd be happy to look that up for you. Could you please provide your 5-digit order number?";
        }
      },
    }),

    defineAction({
      id: "escalate",
      description:
        "Escalate to a human agent. Use when the customer is frustrated, the issue is complex, or they explicitly ask for a human.",
      handler: async (ctx) => {
        const ticket = (await ctx.tools.call("create_ticket", {
          subject: "Customer escalation",
          description: `Customer requested escalation. Context: ${ctx.conversation.currentUtterance}`,
          priority: "high",
        })) as { ticketId: string };

        return `I understand. I have created escalation ticket ${ticket.ticketId} and am transferring you directly to a senior specialist. Please hold.`;
      },
    }),

    defineAction({
      id: "close",
      description:
        "Close the conversation. Use when the customer's issue is resolved or they want to end the call.",
      handler: async () => {
        return "Thank you for contacting Acme Corp support today. Have a wonderful rest of your day, goodbye!";
      },
    }),
  ],

  hooks: {
    onCallStart: async (session) => {
      console.log(`\n📞 Support call started: ${session.id}`);
    },
    onActionSelected: async (action, confidence) => {
      const emoji =
        confidence > 0.7 ? "🟢" : confidence > 0.4 ? "🟡" : "🔴";
      console.log(
        `${emoji} JEV → "${action.id}" (${(confidence * 100).toFixed(1)}%)`,
      );
    },
    onCallEnd: async (session, turns) => {
      console.log(
        `📞 Call ended: ${turns.length} turns, session: ${session.id}\n`,
      );
    },
  },

  logging: {
    enabled: true,
    logDir: "./call-logs",
    level: "info",
  },
});

if (process.argv[1] && (process.argv[1].includes("customer-support") && !process.argv[1].includes("cli"))) {
  agent.listen({ port: 8080 }).then(() => {
    console.log("\n🎧 Acme Support Agent ready on ws://localhost:8080\n");
  });

  process.on("SIGINT", async () => {
    await agent.stop();
    process.exit(0);
  });
}

export default agent;
