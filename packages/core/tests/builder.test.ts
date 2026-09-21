import { describe, it, expect } from "vitest";
import {
  createAgent,
  createSupportAgent,
  createSalesAgent,
  FelAgent,
  defineAction,
  FastSemanticEmbeddingProvider,
} from "../src/index.js";

describe("FastSemanticEmbeddingProvider", () => {
  it("generates normalized 128-d vectors deterministically", async () => {
    const provider = new FastSemanticEmbeddingProvider();
    const v1 = await provider.embed("where is my order");
    const v2 = await provider.embed("where is my order");

    expect(v1.length).toBe(128);
    expect(v2.length).toBe(128);

    // Identical input produces identical vector
    for (let i = 0; i < 128; i++) {
      expect(v1[i]).toBeCloseTo(v2[i], 6);
    }

    // Normalization check (norm = 1)
    let sumSq = 0;
    for (let i = 0; i < 128; i++) sumSq += v1[i] * v1[i];
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 4);
  });
});

describe("FelAgent direct interact & simulate", () => {
  it("allows zero-config instant interaction without external API keys", async () => {
    const agent = new FelAgent({
      name: "Test Logistics",
      actions: [
        defineAction({
          id: "track_package",
          description: "Track shipment location, delivery status, courier, or transit updates for order ID",
          handler: async () => "Your order is scheduled for delivery today.",
        }),
        defineAction({
          id: "fallback",
          description: "Irrelevant questions, out of scope queries, weather, or unhandled requests",
          handler: async () => "Sorry, I am not able to understand.",
        }),
      ],
    });

    const reply = await agent.interact("where is my package");
    expect(reply.action.id).toBe("track_package");
    expect(reply.text).toBe("Your order is scheduled for delivery today.");
    expect(reply.confidence).toBeGreaterThan(0.5);

    // Fallback for irrelevant query
    const fallbackReply = await agent.interact("can you tell me a joke");
    expect(fallbackReply.action.id).toBe("fallback");
    expect(fallbackReply.text).toBe("Sorry, I am not able to understand.");
  });

  it("supports multi-turn simulate() with persistent context", async () => {
    const agent = new FelAgent({
      name: "Sim Agent",
      actions: [
        defineAction({
          id: "greet",
          description: "Warm greeting to the caller",
          handler: async () => "Hello! How can I help you?",
        }),
        defineAction({
          id: "order_status",
          description: "Order status and delivery date tracking",
          handler: async (ctx) => {
            const orderId = ctx.memory.getSlot("orderId") || "ACM-9281";
            return `Order ${orderId} is on the truck.`;
          },
        }),
      ],
    });

    agent.memory.setSlot("orderId", "ACM-5555");

    const history = await agent.simulate([
      "hello there",
      "where is my shipment",
    ]);

    expect(history.length).toBe(2);
    expect(history[0].action.id).toBe("greet");
    expect(history[1].action.id).toBe("order_status");
    expect(history[1].text).toContain("ACM-5555");
  });
});

describe("createAgent Fluent Builder", () => {
  it("builds and interacts with a clean fluent API", async () => {
    const agent = createAgent("Concierge")
      .system("You are an upscale hotel concierge.")
      .slot("roomNumber", "402")
      .action(
        "room_service",
        "Request room service, fresh towels, extra pillows, or dinner",
        async (ctx) => {
          const room = ctx.memory.getSlot("roomNumber") || "your room";
          return `Fresh towels are on the way to room ${room}.`;
        }
      )
      .fallback("Sorry, I am not able to understand that request.");

    const res = await agent.interact("can I get fresh towels please");
    expect(res.action.id).toBe("room_service");
    expect(res.text).toBe("Fresh towels are on the way to room 402.");

    // Unrecognized query routes to fallback
    const res2 = await agent.interact("what is 42 multiplied by 7");
    expect(res2.action.id).toBe("fallback");
    expect(res2.text).toBe("Sorry, I am not able to understand that request.");
  });
});

describe("Preset Agent Templates", () => {
  it("createSupportAgent provides out-of-the-box Tier-1 customer support", async () => {
    const support = createSupportAgent({
      companyName: "Acme Hardware",
      orderLookup: async (id) => ({ status: "delivered", eta: "yesterday" }),
    });

    const res1 = await support.interact("where is my order ACM-1234");
    expect(res1.action.id).toBe("order_status");
    expect(res1.text).toContain("delivered");

    const res2 = await support.interact("the tts is not working");
    expect(res2.action.id).toBe("fallback");
    expect(res2.text).toContain("Sorry, I am not able to understand");
  });

  it("createSalesAgent provides out-of-the-box outbound SDR qualification", async () => {
    const sales = createSalesAgent({
      companyName: "HyperVoice",
      repName: "Sam",
    });

    const res1 = await sales.interact("how much does this cost?");
    expect(res1.action.id).toBe("handle_pricing");

    const res2 = await sales.interact("tell me about the weather");
    expect(res2.action.id).toBe("fallback");
  });

  it("configures all STT and TTS providers via fluent methods", () => {
    const builder = createAgent("MultiProviderAgent")
      .whisper({ apiKey: "whisper-key", model: "whisper-1", language: "en" })
      .cartesia({ apiKey: "cartesia-key", voice: "voice-id-456" });

    const agent = builder.build();
    expect(agent.name).toBe("MultiProviderAgent");

    const builder2 = createAgent("AzureAgent")
      .azureSTT({ apiKey: "az-stt-key", region: "westus2" })
      .azureTTS({ apiKey: "az-tts-key", region: "westus2", voice: "en-US-JennyNeural" });

    const agent2 = builder2.build();
    expect(agent2.name).toBe("AzureAgent");

    const builder3 = createAgent("OtherProvidersAgent")
      .assemblyai({ apiKey: "aai-key" })
      .openaiTTS({ apiKey: "oai-key", voice: "alloy" })
      .googleSTT({ apiKey: "goog-key" })
      .polly({ apiKey: "polly-key", region: "us-west-2" })
      .lmnt({ apiKey: "lmnt-key", voice: "lily" });

    const agent3 = builder3.build();
    expect(agent3.name).toBe("OtherProvidersAgent");
  });
});
