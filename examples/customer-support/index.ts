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
  llm: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
  },

  tools: [lookupOrderTool, createTicketTool],

  actions: [
    defineAction({
      id: "greet",
      description:
        "Greet the customer and ask how you can help. Use at the start of the conversation.",
      handler: async (ctx) => {
        return ctx.llm.generate(
          "Greet the customer professionally. Introduce yourself as Acme Corp support and ask how you can assist them today.",
          { systemPrompt: ctx.conversation.systemPrompt },
        );
      },
    }),

    defineAction({
      id: "troubleshoot",
      description:
        "Help the customer troubleshoot a technical issue. Ask clarifying questions to understand the problem.",
      handler: async (ctx) => {
        return ctx.llm.generate(
          `Help troubleshoot the customer's issue. Ask clarifying questions if needed.
Customer said: "${ctx.conversation.currentUtterance}"`,
          {
            systemPrompt: ctx.conversation.systemPrompt,
            history: ctx.memory.getRecentTurns(10).map((t) => ({
              role:
                t.role === "user"
                  ? ("user" as const)
                  : ("assistant" as const),
              content: t.content,
            })),
          },
        );
      },
    }),

    defineAction({
      id: "lookup_order",
      description:
        "Look up an order status for the customer. Use when they ask about their order, delivery, or tracking.",
      handler: async (ctx) => {
        // Try to extract order ID from the conversation
        const utterance = ctx.conversation.currentUtterance;
        const orderIdMatch = utterance.match(/\b\d{5,}\b/);

        if (orderIdMatch) {
          const result = await ctx.tools.call("lookup_order", {
            orderId: orderIdMatch[0],
          });
          const order = result as Record<string, unknown>;
          ctx.memory.setSlot("orderId", order.orderId);
          ctx.memory.setSlot("orderStatus", order.status);

          return ctx.llm.generate(
            `Tell the customer about their order. Order details: ${JSON.stringify(order)}`,
            { systemPrompt: ctx.conversation.systemPrompt },
          );
        } else {
          return ctx.llm.generate(
            "Ask the customer for their order number so you can look it up.",
            { systemPrompt: ctx.conversation.systemPrompt },
          );
        }
      },
    }),

    defineAction({
      id: "escalate",
      description:
        "Escalate to a human agent. Use when the customer is frustrated, the issue is complex, or they explicitly ask for a human.",
      handler: async (ctx) => {
        const ticket = await ctx.tools.call("create_ticket", {
          subject: "Customer escalation",
          description: `Customer conversation escalated. Context: ${ctx.conversation.currentUtterance}`,
          priority: "high",
        });

        return ctx.llm.generate(
          `Let the customer know you're transferring them to a human agent. 
A ticket has been created: ${JSON.stringify(ticket)}. 
Apologize for any inconvenience and assure them they'll be helped soon.`,
          { systemPrompt: ctx.conversation.systemPrompt },
        );
      },
    }),

    defineAction({
      id: "close",
      description:
        "Close the conversation. Use when the customer's issue is resolved or they want to end the call.",
      handler: async (ctx) => {
        return ctx.llm.generate(
          "Thank the customer for calling Acme Corp support. Wish them a great day. Ask if there's anything else before hanging up.",
          { systemPrompt: ctx.conversation.systemPrompt },
        );
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

agent.listen({ port: 8080 }).then(() => {
  console.log("\n🎧 Acme Support Agent ready on ws://localhost:8080\n");
});

process.on("SIGINT", async () => {
  await agent.stop();
  process.exit(0);
});
