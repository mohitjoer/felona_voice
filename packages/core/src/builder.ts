import { FelAgent, defineAction } from "./agent.js";
import type {
  AgentAction,
  ActionContext,
  EmbeddingProvider,
  InteractOptions,
  InteractResult,
  STTProvider,
  TTSProvider,
} from "./types.js";
import type {
  GraphData,
  VisualizeOptions,
  VisualizeResult,
} from "./graph/visualize.js";

export type ActionHandlerFn = (
  ctx: ActionContext
) => Promise<string> | string;

export class AgentBuilder {
  private agentName: string;
  private agentSystemPrompt = "You are a helpful, conversational AI voice assistant.";
  private actionList: AgentAction[] = [];
  private slots: Record<string, unknown> = {};
  private sttConfig?: { provider: string; apiKey?: string; [k: string]: unknown } | STTProvider;
  private ttsConfig?: { provider: string; apiKey?: string; voice?: string; [k: string]: unknown } | TTSProvider;
  private customEmbeddingProvider?: EmbeddingProvider;
  private confidenceThreshold = 0.35;
  private builtAgent?: FelAgent;

  constructor(name = "Felona Agent") {
    this.agentName = name;
  }

  /** Set the agent's name */
  name(name: string): this {
    this.agentName = name;
    return this;
  }

  /** Set system personality / prompt */
  system(prompt: string): this {
    this.agentSystemPrompt = prompt;
    return this;
  }

  /** Add an initial slot */
  slot(key: string, value: unknown): this {
    this.slots[key] = value;
    return this;
  }

  /** Add multiple initial slots */
  slotsRecord(slots: Record<string, unknown>): this {
    Object.assign(this.slots, slots);
    return this;
  }

  /** Define a conversational action */
  action(
    id: string,
    description: string,
    handler: string | ActionHandlerFn,
    metadata?: Record<string, unknown>
  ): this {
    this.actionList.push(
      defineAction({
        id,
        description,
        handler: async (ctx) => {
          if (typeof handler === "string") return handler;
          return handler(ctx);
        },
        metadata,
      })
    );
    return this;
  }

  /** Fallback action when JEV prediction is below confidence threshold */
  fallback(responseOrHandler?: string | ActionHandlerFn): this {
    const text = typeof responseOrHandler === "string" ? responseOrHandler : undefined;
    const fn = typeof responseOrHandler === "function" ? responseOrHandler : undefined;

    return this.action(
      "fallback",
      "Fallback for out of scope questions, trivia, speech noise, or unhandled requests",
      fn || text || "Sorry, I am not able to understand. Could you please clarify?"
    );
  }

  /** Set STT provider directly or by configuration */
  stt(provider: STTProvider | { provider: string; apiKey?: string; [k: string]: unknown }): this {
    this.sttConfig = provider;
    return this;
  }

  /** Set TTS provider directly or by configuration */
  tts(provider: TTSProvider | { provider: string; apiKey?: string; voice?: string; [k: string]: unknown }): this {
    this.ttsConfig = provider;
    return this;
  }

  /** Configure Deepgram for STT and/or TTS */
  deepgram(options: { apiKey: string; ttsVoice?: string }): this {
    this.sttConfig = {
      provider: "deepgram",
      apiKey: options.apiKey,
    };
    if (options.ttsVoice) {
      this.ttsConfig = {
        provider: "deepgram",
        apiKey: options.apiKey,
        voice: options.ttsVoice,
      };
    }
    return this;
  }

  /** Configure ElevenLabs for TTS */
  elevenlabs(options: { apiKey: string; voice?: string }): this {
    this.ttsConfig = {
      provider: "elevenlabs",
      apiKey: options.apiKey,
      voice: options.voice ?? "21m00Tcm4TlvDq8ikWAM",
    };
    return this;
  }

  /** Configure OpenAI Whisper for STT */
  whisper(options: { apiKey: string; model?: string; language?: string }): this {
    this.sttConfig = {
      provider: "whisper",
      apiKey: options.apiKey,
      model: options.model,
      language: options.language,
    };
    return this;
  }

  /** Configure AssemblyAI for streaming STT */
  assemblyai(options: { apiKey: string; sampleRate?: number }): this {
    this.sttConfig = {
      provider: "assemblyai",
      apiKey: options.apiKey,
      sampleRate: options.sampleRate,
    };
    return this;
  }

  /** Configure Azure Speech for STT */
  azureSTT(options: { apiKey: string; region: string; language?: string }): this {
    this.sttConfig = {
      provider: "azure",
      apiKey: options.apiKey,
      region: options.region,
      language: options.language,
    };
    return this;
  }

  /** Configure Google Cloud Speech for STT */
  googleSTT(options: { apiKey: string; language?: string; model?: string }): this {
    this.sttConfig = {
      provider: "google",
      apiKey: options.apiKey,
      language: options.language,
      model: options.model,
    };
    return this;
  }

  /** Configure OpenAI Speech for TTS */
  openaiTTS(options: { apiKey: string; voice?: string; model?: string; speed?: number }): this {
    this.ttsConfig = {
      provider: "openai",
      apiKey: options.apiKey,
      voice: options.voice ?? "nova",
      model: options.model ?? "tts-1",
      speed: options.speed,
    };
    return this;
  }

  /** Configure Cartesia Sonic for ultra-low latency TTS (<100ms) */
  cartesia(options: { apiKey: string; voice?: string; modelId?: string }): this {
    this.ttsConfig = {
      provider: "cartesia",
      apiKey: options.apiKey,
      voice: options.voice,
      modelId: options.modelId,
    };
    return this;
  }

  /** Configure Azure Cognitive Services for TTS */
  azureTTS(options: { apiKey: string; region: string; voice?: string; language?: string }): this {
    this.ttsConfig = {
      provider: "azure",
      apiKey: options.apiKey,
      region: options.region,
      voice: options.voice,
      language: options.language,
    };
    return this;
  }

  /** Configure Amazon Polly for TTS */
  polly(options: { apiKey?: string; region?: string; voice?: string }): this {
    this.ttsConfig = {
      provider: "polly",
      apiKey: options.apiKey,
      region: options.region,
      voice: options.voice,
    };
    return this;
  }

  /** Configure LMNT for streaming TTS */
  lmnt(options: { apiKey: string; voice?: string }): this {
    this.ttsConfig = {
      provider: "lmnt",
      apiKey: options.apiKey,
      voice: options.voice,
    };
    return this;
  }

  /** Use a custom embedding provider */
  embedding(provider: EmbeddingProvider): this {
    this.customEmbeddingProvider = provider;
    return this;
  }

  /** Set minimum confidence threshold (0 to 1, default 0.35) */
  threshold(threshold: number): this {
    this.confidenceThreshold = threshold;
    return this;
  }

  /** Build and return the initialized FelAgent instance */
  build(): FelAgent {
    if (this.builtAgent) return this.builtAgent;

    // Ensure fallback exists
    const hasFallback = this.actionList.some((a) => a.id === "fallback");
    if (!hasFallback) {
      this.fallback();
    }

    const agent = new FelAgent({
      name: this.agentName,
      systemPrompt: this.agentSystemPrompt,
      actions: this.actionList,
      stt: this.sttConfig,
      tts: this.ttsConfig,
      jev: {
        embeddingProvider: this.customEmbeddingProvider,
        confidenceThreshold: this.confidenceThreshold,
      },
    });

    // Populate initial slots into agent memory
    for (const [k, v] of Object.entries(this.slots)) {
      agent.memory.setSlot(k, v);
    }

    this.builtAgent = agent;
    return agent;
  }

  /** Direct interaction shortcut: simulates a turn without needing to call build() first */
  async interact(input: string | InteractOptions): Promise<InteractResult> {
    return this.build().interact(input);
  }

  /** Start listening on WebSocket port */
  async listen(options?: { port?: number; host?: string }): Promise<void> {
    return this.build().listen(options);
  }

  /**
   * Get graph data representing the agent's action space.
   */
  getGraph(): GraphData {
    return this.build().getGraph();
  }

  /**
   * Render an ASCII diagram in the terminal.
   */
  drawAscii(options?: { title?: string }): string {
    return this.build().drawAscii(options);
  }

  /**
   * Export the agent's action space as a Mermaid flowchart.
   */
  drawMermaid(): string {
    return this.build().drawMermaid();
  }

  /**
   * Export the agent's action space as Markdown documentation.
   */
  drawMarkdown(options?: { title?: string }): string {
    return this.build().drawMarkdown(options);
  }

  /**
   * Get a direct link to view the diagram in Mermaid Live Editor.
   */
  toMermaidLiveUrl(): string {
    return this.build().toMermaidLiveUrl();
  }

  /**
   * Visualize the agent in terminal (ASCII), Mermaid, or launch the interactive HTML visualizer.
   */
  async visualize(options?: VisualizeOptions): Promise<VisualizeResult> {
    return this.build().visualize(options);
  }
}

/**
 * Fluent builder factory for creating Felona Voice agents with zero boilerplate.
 *
 * @example
 * ```typescript
 * import { createAgent } from "felona-voice";
 *
 * const agent = createAgent("Concierge")
 *   .system("You are an upscale hotel concierge.")
 *   .action("book_dinner", "Book a dining table reservation", async () => "Table booked for 7 PM.")
 *   .action("room_service", "Order room service or towels", async () => "Room service is on the way.")
 *   .fallback("Sorry, I am not able to understand. How may I assist your stay?");
 *
 * const reply = await agent.interact("can I get clean towels?");
 * console.log(reply.text); // "Room service is on the way."
 * ```
 */
export function createAgent(name?: string): AgentBuilder {
  return new AgentBuilder(name);
}

/**
 * Ready-to-use Tier-1 Customer Support Voice Agent template.
 */
export function createSupportAgent(options?: {
  companyName?: string;
  orderLookup?: (orderId: string) => Promise<{ status: string; eta?: string } | null>;
  slots?: Record<string, unknown>;
  deepgramApiKey?: string;
  embeddingProvider?: EmbeddingProvider;
}): AgentBuilder {
  const company = options?.companyName ?? "Acme Support";

  const builder = createAgent(company)
    .system(`You are an empathetic, concise customer support agent for ${company}. Assist callers with orders, devices, returns, and escalation.`)
    .slotsRecord({
      companyName: company,
      orderId: "ACM-9281",
      customerName: "Alex",
      ...(options?.slots ?? {}),
    })
    .action(
      "greet",
      "Welcome customer warmly, greet by name, ask how to assist with products",
      async (ctx) => {
        const name = ctx.memory.getSlot("customerName") ?? "there";
        return `Hello ${name}! Thank you for calling ${company}. How can I assist you with your order or device today?`;
      }
    )
    .action(
      "order_status",
      "Inquire about delivery date, shipment tracking courier, or transit updates for order ID",
      async (ctx) => {
        const orderId = (ctx.memory.getSlot("orderId") as string) ?? "ACM-9281";
        if (options?.orderLookup) {
          const res = await options.orderLookup(orderId);
          if (res) return `Your order ${orderId} is currently ${res.status}${res.eta ? ` and scheduled to arrive ${res.eta}` : ""}.`;
        }
        return `I checked order ${orderId} — it is currently out for delivery via FedEx Priority and scheduled to arrive today by 4:30 PM.`;
      }
    )
    .action(
      "troubleshoot",
      "Help troubleshoot broken device, hardware power reboot, blinking red light, or connectivity failure",
      async () => {
        return `Let's troubleshoot that together. First, ensure your device is unplugged for 10 seconds, then hold down the power button while reconnecting. Did the status LED turn solid blue?`;
      }
    )
    .action(
      "refund_request",
      "Process product return, request refund, billing dispute, or return shipping label",
      async (ctx) => {
        const orderId = ctx.memory.getSlot("orderId") ?? "ACM-9281";
        return `I have initiated your refund for order ${orderId}. A prepaid return shipping label has been dispatched to your email on file.`;
      }
    )
    .action(
      "escalate_supervisor",
      "Customer is frustrated, demands human intervention, speaks with manager, or asks for a supervisor",
      async () => {
        return `I apologize for the frustration. I am escalating this call immediately to our Senior Support Lead on duty. Please stay on the line while I connect you.`;
      }
    )
    .action(
      "goodbye",
      "Customer thanks the agent, says goodbye, or indicates issue is resolved",
      async () => `You're very welcome! Thank you for choosing ${company}. Have a wonderful day!`
    )
    .fallback(
      `Sorry, I am not able to understand. How can I assist you with your order, device, or refund today?`
    );

  if (options?.deepgramApiKey) {
    builder.deepgram({ apiKey: options.deepgramApiKey, ttsVoice: "aura-asteria-en" });
  }
  if (options?.embeddingProvider) {
    builder.embedding(options.embeddingProvider);
  }

  return builder;
}

/**
 * Ready-to-use Outbound Sales Qualification Voice Agent template.
 */
export function createSalesAgent(options?: {
  companyName?: string;
  repName?: string;
  slots?: Record<string, unknown>;
  deepgramApiKey?: string;
  embeddingProvider?: EmbeddingProvider;
}): AgentBuilder {
  const company = options?.companyName ?? "Pulse AI";
  const rep = options?.repName ?? "Jordan";

  const builder = createAgent(`${company} SDR`)
    .system(`You are ${rep}, an articulate and enthusiastic sales development rep at ${company}. Qualify prospect infrastructure and book live demos.`)
    .slotsRecord(options?.slots ?? {})
    .action(
      "pitch_intro",
      "Introduce 10-second elevator pitch, value proposition of voice latency reduction, and reason for calling",
      async () => `Hi there! ${rep} calling from ${company}. We help engineering teams cut voice agent latency down to sub-150 milliseconds. Did I catch you at a good time?`
    )
    .action(
      "handle_pricing",
      "Address pricing objections, explain open-source savings, and transparent per-minute token usage",
      async () => `Our core framework is open-source, so you only pay for your raw model compute and upstream audio providers, saving up to 80% over managed platforms.`
    )
    .action(
      "book_demo",
      "Schedule 20-minute technical architecture deep dive with Solutions Architect",
      async () => `Fantastic! I have openings with our solutions engineer this Thursday at 11:00 AM PST or Friday at 2:00 PM PST. Which works better for your calendar?`
    )
    .action(
      "not_interested",
      "Prospect asks to be removed, says not interested, or bad timing",
      async () => `No problem at all! Thanks for your candidness. I'll make a note and won't bother you further. Have a great rest of your week!`
    )
    .fallback(
      `Sorry, I am not able to understand. I'm reaching out from ${company} regarding latency reduction in voice AI. How can I assist your team?`
    );

  if (options?.deepgramApiKey) {
    builder.deepgram({ apiKey: options.deepgramApiKey });
  }
  if (options?.embeddingProvider) {
    builder.embedding(options.embeddingProvider);
  }

  return builder;
}
