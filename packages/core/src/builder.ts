import { FelAgent, defineAction } from "./agent.js";
import type {
  AgentAction,
  AgentTool,
  ActionContext,
  EmbeddingProvider,
  InteractOptions,
  InteractResult,
  STTProvider,
  TTSProvider,
  Transport,
  SessionManagerOptions,
  SessionStore,
} from "./types.js";
import type {
  GraphData,
  VisualizeOptions,
  VisualizeResult,
} from "./graph/visualize.js";
import { createCollectTask, type CollectTaskOptions } from "./slots/tasks.js";
import { createKnowledgeTask, type KnowledgeTaskOptions } from "./knowledge/task.js";
import type { KnowledgeSearcher } from "./knowledge/kb.js";
import type { McpClient } from "./tools/mcp.js";
import { turnsToMessages, type LLMChatOptions, type LLMProvider } from "./llm/index.js";
import type { AnalyzeOptions } from "./analytics/call-analysis.js";
import type { FelonaTracer } from "./observability/tracing.js";

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
  private transportConfig?: ({ type?: "websocket" | "twilio" | "webrtc"; port?: number; host?: string; path?: string; streamUrl?: string; [k: string]: unknown } | Transport);
  private sessionConfig?: SessionManagerOptions;
  /** Ids of knowledge tasks materialised into `actionList`, so rebuilds can replace rather than duplicate them. */
  private knowledgeTaskIds = new Set<string>();
  private builtAgent?: FelAgent;
  /** Knowledge tasks awaiting an agent to supply a knowledge base. */
  private pendingKnowledgeTasks: Array<Omit<KnowledgeTaskOptions, "knowledge">> = [];
  private pendingTools: AgentTool[] = [];
  private pendingMcpClients: McpClient[] = [];
  private analysisConfig?: AnalyzeOptions;
  private tracerConfig?: FelonaTracer;
  /** Action count the cached agent was built from, to detect a stale cache. */
  private builtFromActionCount = -1;
  private builtFromToolCount = -1;

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

  /**
   * Add a catch-all action backed by an LLM.
   *
   * This is the "let the model handle whatever it is asked" path, and it sits
   * alongside hand-written `action()`s rather than replacing them: JEV still
   * routes, so a narrow action with a deterministic handler wins where one
   * exists and the model covers the long tail.
   *
   * The handler receives the turn's `signal`, so a caller interrupting mid-answer
   * cancels the model request instead of paying for a completion nobody hears.
   */
  llm(
    description: string,
    options: LLMChatOptions & { llm: LLMProvider },
  ): this {
    const { llm: provider, ...chatOptions } = options;
    this.actionList.push(
      defineAction({
        id: "llm",
        description,
        handler: async (ctx) => {
          const result = await provider.chat({
            ...chatOptions,
            userMessage: ctx.conversation.currentUtterance,
            // `turns` holds committed history only; the utterance being routed
            // arrives separately as `userMessage`. Slicing the last turn off
            // here would drop the caller's most recent exchange.
            messages: turnsToMessages(ctx.conversation.turns),
            tools: ctx.tools.list(),
            signal: ctx.signal,
          });
          // Reported so the turn's tokens land in per-call cost. Without this
          // the largest cost in a voice agent goes unmeasured.
          if (result.usage) {
            ctx.reportUsage?.({
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            });
          }
          return result.text;
        },
      }),
    );
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

  /**
   * Register a tool the LLM may call during a call.
   *
   * Tools are distinct from actions: an action is something JEV *predicts* and
   * the agent *says*, a tool is something the LLM *calls* to get information it
   * then speaks. A tool returns data; it does not produce the reply.
   */
  tool(tool: AgentTool): this {
    if (this.pendingTools.some((t) => t.name === tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.pendingTools.push(tool);
    return this;
  }

  /** Register several tools at once. Duplicate names throw. */
  tools(toolList: AgentTool[]): this {
    for (const t of toolList) this.tool(t);
    return this;
  }

  /**
   * Expose an MCP server's tools to the agent.
   *
   * `build()` is synchronous and listing an MCP server is not — the server is a
   * subprocess that has to be asked over a pipe. So this records the server and
   * you finish with {@link AgentBuilder.connectMcp} instead of `build()`.
   */
  mcp(client: McpClient): this {
    if (this.pendingMcpClients.includes(client)) {
      throw new Error("This MCP client is already registered on the agent");
    }
    this.pendingMcpClients.push(client);
    return this;
  }

  /**
   * Connect every registered MCP server, add its tools, and return the agent.
   *
   * A server that cannot be reached fails the whole call. Returning an agent
   * that quietly lacks the tools it was promised is worse than an error, because
   * the failure only shows up mid-conversation.
   */
  async connectMcp(): Promise<FelAgent> {
    const agent = this.build();
    for (const client of this.pendingMcpClients) {
      // A duplicate name across two servers throws here rather than letting one
      // silently shadow the other.
      await client.registerInto(agent.toolRegistry);
    }
    return agent;
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

  /**
   * Add a knowledge-base action.
   *
   * Searches the built agent's knowledge base and hands the passages to your
   * `answer` function. The framework does not compose an answer for you — that
   * keeps the reply exactly what you return, with no model in the loop.
   *
   * @example
   * ```typescript
   * const agent = createAgent("Support").build();
   * await agent.knowledge.addAll([
   *   { id: "returns", text: "Returns are accepted within 30 days." },
   * ]);
   *
   * createAgent("Support")
   *   .knowledgeTask({
   *     answer: (results) =>
   *       results.length
   *         ? results[0].text
   *         : "I'm not sure on that one — let me check and call you back.",
   *   });
   * ```
   */
  knowledgeTask(options: Omit<KnowledgeTaskOptions, "knowledge">): this {
    // Deferred, not resolved here: the knowledge base belongs to the built
    // agent, and building mid-chain would freeze the action list and silently
    // drop anything added afterwards.
    this.pendingKnowledgeTasks.push(options);
    return this;
  }

  /**
   * Add a slot-collection task — the flow for capturing a name, email, phone
   * number, address or card details across several turns.
   *
   * The task becomes a normal action, so JEV routes to it by description. The
   * handler returns the next question, and collected values are validated
   * (including a Luhn check on card numbers) before being accepted.
   *
   * @example
   * ```typescript
   * createAgent("Checkout")
   *   .action("start_order", "Begin a new order", "Let's get started.")
   *   .collect({
   *     id: "take_details",
   *     slots: [
   *       { name: "name", type: "name" },
   *       { name: "email", type: "email" },
   *       { name: "cardNumber", type: "cardNumber" },
   *     ],
   *     onComplete: (s) => `Thanks ${s.name}, order confirmed.`,
   *   });
   * ```
   */
  collect(options: CollectTaskOptions): this {
    this.actionList.push(createCollectTask(options));
    return this;
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

  /**
   * Instrument calls with a specific OpenTelemetry tracer.
   *
   * Omit it and the agent uses the global OpenTelemetry tracer, which does
   * nothing until your application registers a provider. Pass one to control
   * the instrumentation scope, or to assert on spans in a test.
   */
  tracer(tracer: FelonaTracer): this {
    this.tracerConfig = tracer;
    return this;
  }

  /**
   * Tell the agent how to judge a call when it ends.
   *
   * Post-call analysis can only infer an outcome from the transcript on its own.
   * Naming the actions that end well — or passing `resolve` when your systems
   * know the real outcome — is what makes the result trustworthy enough to bill
   * or escalate on.
   *
   * ```typescript
   * createAgent("Support")
   *   .analysis({
   *     successActions: ["order_confirmed", "refund_issued"],
   *     escalationActions: ["transfer_human"],
   *   })
   * ```
   */
  analysis(options: AnalyzeOptions): this {
    this.analysisConfig = options;
    return this;
  }

  /** Set minimum confidence threshold (0 to 1, default 0.35) */
  threshold(threshold: number): this {
    this.confidenceThreshold = threshold;
    return this;
  }

  /** Build and return the initialized FelAgent instance */
  build(): FelAgent {
    // A cached agent is only valid for the action list it was built from.
    // Without this check, any action added after an early build() is silently
    // ignored.
    if (
      this.builtAgent &&
      this.builtFromActionCount === this.actionList.length &&
      this.builtFromToolCount === this.pendingTools.length
    ) {
      return this.builtAgent;
    }
    this.builtAgent = undefined;

    // Ensure fallback exists
    if (!this.actionList.some((a) => a.id === "fallback")) {
      this.fallback();
    }

    // Knowledge tasks are declared before the agent that owns the knowledge
    // base exists. Each is wired through a holder resolved immediately after
    // construction, so no half-initialized base is captured and nothing relies
    // on the action array being mutated behind the agent's back.
    const knowledgeHolders: Array<{ searcher: KnowledgeSearcher | null }> = [];

    // These tasks are materialised into `actionList` here. On a rebuild after
    // a cache miss the previous copies are still in the list, so pushing again
    // would produce duplicate action ids — which JEV rejects at initialize.
    // Removing them first keeps exactly one copy per configured knowledge base.
    if (this.knowledgeTaskIds.size > 0) {
      this.actionList = this.actionList.filter(
        (a) => !this.knowledgeTaskIds.has(a.id),
      );
    }

    for (const options of this.pendingKnowledgeTasks) {
      const holder: { searcher: KnowledgeSearcher | null } = { searcher: null };
      knowledgeHolders.push(holder);

      const task = createKnowledgeTask({
          ...options,
          knowledge: {
            search: (query, searchOptions) => {
              if (!holder.searcher) {
                throw new Error(
                  "Knowledge base is unavailable — the agent was not built correctly.",
                );
              }
              return holder.searcher.search(query, searchOptions);
            },
          },
        });
      this.actionList.push(task);
      this.knowledgeTaskIds.add(task.id);
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
      transport: this.transportConfig,
      sessions: this.sessionConfig,
      tools: this.pendingTools,
      analysis: this.analysisConfig,
      tracer: this.tracerConfig,
    });

    for (const holder of knowledgeHolders) {
      holder.searcher = agent.knowledge;
    }

    // Populate initial slots into agent memory
    for (const [k, v] of Object.entries(this.slots)) {
      agent.memory.setSlot(k, v);
    }

    this.builtAgent = agent;
    this.builtFromActionCount = this.actionList.length;
    this.builtFromToolCount = this.pendingTools.length;
    return agent;
  }

    /** Direct interaction shortcut: simulates a turn without needing to call build() first */
  async interact(input: string | InteractOptions): Promise<InteractResult> {
    return this.build().interact(input);
  }

  /** Start listening on WebSocket port */
  async listen(options?: { port?: number; host?: string; path?: string }): Promise<void> {
    return this.build().listen(options);
  }

  /**
   * Configure agent to connect with Twilio Media Streams and mobile phone carriers.
   *
   * `authToken` and `publicUrl` are what make `X-Twilio-Signature` validation
   * possible, and they are the only thing standing between a public webhook and
   * a stranger placing calls into your agent. Without them the transport runs
   * unauthenticated and warns on every signed request; set `allowUnverified`
   * to opt out deliberately (e.g. behind a private network).
   */
  twilio(options?: {
    port?: number;
    host?: string;
    path?: string;
    webhookPath?: string | null;
    streamUrl?: string;
    greeting?: string;
    /** Twilio auth token, used to validate X-Twilio-Signature. */
    authToken?: string;
    /** Public base URL of this server, e.g. "https://voice.example.com". */
    publicUrl?: string;
    /** Restrict the TwiML webhook to these Host values. */
    allowedHosts?: string[];
    /**
     * Accept unsigned webhook requests. Default: false.
     * Only for deployments where the webhook is unreachable except by Twilio.
     */
    allowUnverified?: boolean;
  }): this {
    this.transportConfig = {
      type: "twilio",
      ...options,
    };
    return this;
  }

  /**
   * Set custom Transport instance or transport options.
   */
  transport(
    config:
      | Transport
      | {
          type?: "websocket" | "twilio" | "webrtc";
          port?: number;
          host?: string;
          path?: string;
          streamUrl?: string;
          [k: string]: unknown;
        }
  ): this {
    this.transportConfig = config;
    return this;
  }

  /**
   * Configure session concurrency, TTL, and scaling.
   * By default, sessions remain ephemeral in memory during the active call only.
   * If you provide an external store/database (e.g. Redis), session history is persisted.
   */
  sessions(config: SessionManagerOptions): this {
    this.sessionConfig = { ...this.sessionConfig, ...config };
    return this;
  }

  /**
   * Limit maximum concurrent active calls/sessions to scale and prevent node overload.
   */
  maxConcurrent(limit: number): this {
    this.sessionConfig = { ...this.sessionConfig, maxConcurrent: limit };
    return this;
  }

  /**
   * Attach an external database or key-value store for session persistence.
   */
  sessionStore(store: SessionStore): this {
    this.sessionConfig = { ...this.sessionConfig, store };
    return this;
  }

  /**
   * Start a dedicated Twilio Telephony media stream server directly from the builder.
   */
  async listenTwilio(options?: {
    port?: number;
    host?: string;
    path?: string;
    webhookPath?: string | null;
    streamUrl?: string;
    greeting?: string;
  }): Promise<FelAgent> {
    const agent = this.build();
    await agent.listenTwilio(options);
    return agent;
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
  /**
   * E.164 or SIP destination for supervisor escalations. Without it the agent
   * tells the caller it cannot transfer rather than claiming to.
   */
  escalationNumber?: string;
}): AgentBuilder {
  const company = options?.companyName ?? "Acme Support";
  const escalationNumber = options?.escalationNumber ?? "";

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
      "Customer is frustrated, demands human intervention, speaks with a manager, or asks for a supervisor",
      async (ctx) => {
        // Only claim a handoff when one can actually happen. Telling a caller
        // they are being connected while doing nothing is worse than saying no.
        if (!ctx.transfer) {
          return "I can pass your details to a human colleague, " +
            "but this agent is not connected to a transfer service right now. " +
            "Would you like me to note the issue for a callback instead?";
        }

        const orderId = (ctx.memory.getSlot("orderId") as string) ?? "";
        const name = (ctx.memory.getSlot("customerName") as string) ?? "the customer";

        // Warm transfer: this introduction is spoken in full before the line
        // changes, and the receiving agent gets the context as SIP headers.
        ctx.transfer({
          mode: "warm",
          to: escalationNumber,
          message:
            `I'm transferring you now to a senior support lead who can help directly. ` +
            (orderId ? `Your order reference is ${orderId}. ` : "") +
            "Please hold for just a moment.",
          context: {
            reason: "customer requested a supervisor",
            customerName: name,
            ...(orderId ? { orderId } : {}),
          },
        });

        return "Let me get a colleague for you.";
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
