/**
 * Basic Greeting Agent — The simplest possible Felona Voice agent.
 *
 * This example creates an agent with three actions:
 * - greet: Welcome the user
 * - help: Help the user with their question
 * - farewell: Say goodbye
 *
 * JEV automatically decides which action to take based on what the user says.
 *
 * Usage:
 *   DEEPGRAM_API_KEY=... ELEVEN_API_KEY=... npx tsx examples/basic-greeting/index.ts
 */
import { FelAgent, defineAction } from "felona-voice";

const agent = new FelAgent({
  name: "Greeting Bot",
  systemPrompt:
    "You are a friendly, warm assistant. Keep responses brief and natural.",

  stt: {
    provider: "deepgram",
    apiKey: process.env.DEEPGRAM_API_KEY!,
  },
  tts: {
    provider: "elevenlabs",
    apiKey: process.env.ELEVEN_API_KEY!,
    voice: "21m00Tcm4TlvDq8ikWAM", // Rachel
  },

  actions: [
    defineAction({
      id: "greet",
      description:
        "Greet the user warmly and introduce yourself. Use when the conversation just started or user says hello.",
      handler: async () => {
        return "Hello! I am your Felona Voice assistant. How can I help you today?";
      },
    }),

    defineAction({
      id: "help",
      description:
        "Help the user with their question or request. Use when the user is asking for information, help, or assistance.",
      handler: async (ctx) => {
        return `I can definitely help with "${ctx.conversation.currentUtterance}". What details would you like to know?`;
      },
    }),

    defineAction({
      id: "farewell",
      description:
        "Say goodbye to the user. Use when the user says goodbye, thanks, or indicates they're done.",
      handler: async () => {
        return "Thank you so much for calling! Have a wonderful rest of your day. Goodbye!";
      },
    }),
  ],

  hooks: {
    onCallStart: async (session) => {
      console.log(`📞 Call started: ${session.id}`);
    },
    onActionSelected: async (action, confidence) => {
      console.log(
        `🧠 JEV selected: "${action.id}" (confidence: ${(confidence * 100).toFixed(1)}%)`,
      );
    },
    onUserSpoke: async (text) => {
      console.log(`👤 User: "${text}"`);
    },
    onAgentSpoke: async (text) => {
      console.log(`🤖 Agent: "${text}"`);
    },
    onCallEnd: async (session, turns) => {
      console.log(
        `📞 Call ended: ${session.id} (${turns.length} turns)`,
      );
    },
  },

  logging: {
    enabled: true,
    logDir: "./call-logs",
    level: "info",
  },
});

// Start the agent
agent.listen({ port: 8080 }).then(() => {
  console.log("\n🎙️  Felona Voice agent is ready!");
  console.log("   Connect a WebSocket client to ws://localhost:8080");
  console.log("   Send PCM16 audio (16kHz, mono) as binary frames\n");
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await agent.stop();
  process.exit(0);
});
