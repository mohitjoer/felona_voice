import { EventEmitter } from "node:events";
import type {
  FelAgentConfig,
  Session,
  AudioChunk,
  AgentAction,
  AgentHooks,
  LLMInterface,
} from "./types.js";
import { WebSocketTransport } from "./transport/websocket.js";
import { JEVEngine } from "./jev/engine.js";
import { OpenAIEmbeddingProvider } from "./jev/embeddings.js";
import { ConversationMemory } from "./memory/context.js";
import { ToolRegistry } from "./tools/registry.js";
import { CallLogger } from "./analytics/logger.js";
import { VoicePipeline } from "./pipeline.js";

// Provider imports
import { DeepgramSTT } from "./stt/deepgram.js";
import { ElevenLabsTTS } from "./tts/eleven-labs.js";
import { EnergyVAD } from "./vad/energy.js";
import { OpenAILLM } from "./llm/openai.js";

/**
 * FelAgent — The main entry point for building a voice agent with Felona Voice.
 *
 * Usage:
 * ```typescript
 * const agent = new FelAgent({
 *   name: "Support Bot",
 *   systemPrompt: "You are a helpful support agent.",
 *   stt: { provider: "deepgram", apiKey: "..." },
 *   tts: { provider: "elevenlabs", apiKey: "..." },
 *   llm: { provider: "openai", apiKey: "...", model: "gpt-4o-mini" },
 *   actions: [ ... ],
 * });
 *
 * agent.listen({ port: 8080 });
 * ```
 *
 * FelAgent wires together:
 * - Transport (WebSocket server for audio I/O)
 * - Voice Pipeline (STT → JEV → LLM → TTS per session)
 * - JEV Engine (action prediction)
 * - Memory, Tools, Analytics
 */
export class FelAgent extends EventEmitter {
  private readonly config: FelAgentConfig;
  private transport: WebSocketTransport;
  private readonly jev: JEVEngine;
  private readonly logger: CallLogger;
  private readonly tools: ToolRegistry;
  private readonly hooks: AgentHooks;
  private readonly sttProvider: DeepgramSTT;
  private readonly ttsProvider: ElevenLabsTTS;
  private readonly vadProvider: EnergyVAD;
  private readonly llmProvider: OpenAILLM;
  private readonly llmInterface: LLMInterface;

  // Active pipelines (one per session)
  private pipelines: Map<string, VoicePipeline> = new Map();

  private initialized = false;

  constructor(config: FelAgentConfig) {
    super();
    this.config = config;
    this.hooks = config.hooks ?? {};

    // Initialize logger
    this.logger = new CallLogger({
      logDir: config.logging?.logDir,
      level: config.logging?.level,
      enabled: config.logging?.enabled ?? true,
    });

    // Initialize tools
    this.tools = new ToolRegistry();
    if (config.tools) {
      this.tools.registerAll(config.tools);
    }

    // Initialize providers
    this.sttProvider = this.createSTTProvider();
    this.ttsProvider = this.createTTSProvider();
    this.vadProvider = new EnergyVAD();
    this.llmProvider = this.createLLMProvider();
    this.llmInterface = this.llmProvider.create({
      model: (config.llm.model as string) ?? "gpt-4o-mini",
      temperature: config.llm.temperature as number | undefined,
    });

    // Initialize JEV engine
    const embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey:
        (config.jev?.embeddingApiKey as string) ??
        (config.llm.apiKey as string) ??
        "",
    });
    this.jev = new JEVEngine({
      embeddingProvider,
      confidenceThreshold: config.jev?.confidenceThreshold,
    });

    // Initialize transport
    this.transport = new WebSocketTransport();
  }

  /**
   * Start the agent — initialize JEV, start the transport, begin accepting calls.
   */
  async listen(options?: { port?: number; host?: string }): Promise<void> {
    const port = options?.port ?? this.config.transport?.port ?? 8080;
    const host = options?.host ?? this.config.transport?.host;

    this.logger.log("info", `Starting Felona Voice agent: "${this.config.name}"`);

    // Step 1: Initialize JEV — embed all action descriptions
    this.logger.log("info", "Initializing JEV engine...");
    await this.jev.initialize(this.config.actions);
    this.logger.log(
      "info",
      `JEV initialized with ${this.config.actions.length} actions`,
    );

    // Step 2: Load predictor model if specified
    if (this.config.jev?.predictorModel) {
      await this.jev.loadPredictor(this.config.jev.predictorModel);
    }

    // Step 3: Wire up transport event handlers
    this.transport.onConnect((session) => this.handleConnect(session));
    this.transport.onDisconnect((session) => this.handleDisconnect(session));
    this.transport.onAudioChunk((sessionId, chunk) =>
      this.handleAudio(sessionId, chunk),
    );

    // Step 4: Start the transport server
    await this.transport.start({ port, host });

    this.initialized = true;
    this.logger.log("info", `Agent "${this.config.name}" ready on port ${port}`);
    this.logger.log("info", `  STT: ${this.sttProvider.name}`);
    this.logger.log("info", `  TTS: ${this.ttsProvider.name}`);
    this.logger.log("info", `  LLM: ${this.llmProvider.name}`);
    this.logger.log(
      "info",
      `  JEV: ${this.jev.hasPredictor ? "trained predictor" : "cold-start mode"}`,
    );
    this.logger.log(
      "info",
      `  Actions: ${this.config.actions.map((a) => a.id).join(", ")}`,
    );

    this.emit("ready", { port, host });
  }

  /**
   * Stop the agent — shut down all pipelines and the transport.
   */
  async stop(): Promise<void> {
    this.logger.log("info", "Stopping agent...");

    // Stop all active pipelines
    for (const [sessionId, pipeline] of this.pipelines) {
      await pipeline.stop();
    }
    this.pipelines.clear();

    // Stop transport
    await this.transport.stop();

    this.initialized = false;
    this.logger.log("info", "Agent stopped");
    this.emit("stopped");
  }

  /**
   * Handle a new client connection — create a voice pipeline for this session.
   */
  private async handleConnect(session: Session): Promise<void> {
    this.logger.log("info", `New call: ${session.id}`);

    // Create per-session memory
    const memory = new ConversationMemory();

    // Create a new VAD instance per session (has internal state)
    const vad = new EnergyVAD();

    // Create the voice pipeline for this session
    const pipeline = new VoicePipeline({
      sessionId: session.id,
      session,
      stt: this.sttProvider,
      tts: this.ttsProvider,
      vad,
      llm: this.llmInterface,
      jev: this.jev,
      memory,
      tools: this.tools,
      logger: this.logger,
      hooks: this.hooks,
      systemPrompt: this.config.systemPrompt,
      sendAudio: (chunk) => this.transport.sendAudio(session.id, chunk),
    });

    // Forward pipeline events
    pipeline.on("transcript", (data) =>
      this.emit("transcript", { sessionId: session.id, ...data }),
    );
    pipeline.on("error", (error) =>
      this.emit("error", { sessionId: session.id, error }),
    );
    pipeline.on("bargeIn", () =>
      this.emit("bargeIn", { sessionId: session.id }),
    );

    this.pipelines.set(session.id, pipeline);
    await pipeline.start();

    this.emit("callStarted", session);
  }

  /**
   * Handle a client disconnection — stop and clean up the pipeline.
   */
  private async handleDisconnect(session: Session): Promise<void> {
    this.logger.log("info", `Call ended: ${session.id}`);

    const pipeline = this.pipelines.get(session.id);
    if (pipeline) {
      await pipeline.stop();
      this.pipelines.delete(session.id);
    }

    this.emit("callEnded", session);
  }

  /**
   * Handle incoming audio from a client — route to the correct pipeline.
   */
  private handleAudio(sessionId: string, chunk: AudioChunk): void {
    const pipeline = this.pipelines.get(sessionId);
    if (pipeline) {
      pipeline.processAudio(chunk);
    }
  }

  /** Create STT provider based on config */
  private createSTTProvider(): DeepgramSTT {
    switch (this.config.stt.provider) {
      case "deepgram":
        return new DeepgramSTT({
          apiKey: (this.config.stt.apiKey as string) ?? "",
        });
      default:
        this.logger.log(
          "warn",
          `Unknown STT provider "${this.config.stt.provider}", falling back to Deepgram`,
        );
        return new DeepgramSTT({
          apiKey: (this.config.stt.apiKey as string) ?? "",
        });
    }
  }

  /** Create TTS provider based on config */
  private createTTSProvider(): ElevenLabsTTS {
    switch (this.config.tts.provider) {
      case "elevenlabs":
        return new ElevenLabsTTS({
          apiKey: (this.config.tts.apiKey as string) ?? "",
          voice: this.config.tts.voice as string | undefined,
        });
      default:
        this.logger.log(
          "warn",
          `Unknown TTS provider "${this.config.tts.provider}", falling back to ElevenLabs`,
        );
        return new ElevenLabsTTS({
          apiKey: (this.config.tts.apiKey as string) ?? "",
        });
    }
  }

  /** Create LLM provider based on config */
  private createLLMProvider(): OpenAILLM {
    switch (this.config.llm.provider) {
      case "openai":
        return new OpenAILLM({
          apiKey: (this.config.llm.apiKey as string) ?? "",
        });
      default:
        this.logger.log(
          "warn",
          `Unknown LLM provider "${this.config.llm.provider}", falling back to OpenAI`,
        );
        return new OpenAILLM({
          apiKey: (this.config.llm.apiKey as string) ?? "",
        });
    }
  }

  /** Get the number of active calls */
  get activeCallCount(): number {
    return this.pipelines.size;
  }

  /** Check if the agent is running */
  get isRunning(): boolean {
    return this.initialized;
  }

  /** Get the agent name */
  get name(): string {
    return this.config.name;
  }

  /** Get the JEV engine (for inspection/testing) */
  get jevEngine(): JEVEngine {
    return this.jev;
  }
}

/**
 * Helper to define an action with type safety.
 */
export function defineAction(action: AgentAction): AgentAction {
  return action;
}

/**
 * Quick-start factory — creates a minimal agent with sensible defaults.
 * Automatically creates a default "respond" action that uses the LLM directly.
 */
export function quickStart(config: {
  llm: { provider: string; apiKey: string; model?: string };
  stt: { provider: string; apiKey: string };
  tts: { provider: string; apiKey: string; voice?: string };
  systemPrompt?: string;
}): FelAgent {
  return new FelAgent({
    name: "Felona Agent",
    systemPrompt:
      config.systemPrompt ??
      "You are a helpful, friendly voice assistant. Keep your responses concise and conversational.",
    stt: config.stt,
    tts: config.tts,
    llm: config.llm,
    actions: [
      defineAction({
        id: "respond",
        description:
          "Respond to the user's message helpfully and conversationally",
        handler: async (ctx) => {
          const response = await ctx.llm.generate(
            `Respond to the user naturally. User said: "${ctx.conversation.currentUtterance}"`,
            {
              systemPrompt: ctx.conversation.systemPrompt,
              history: ctx.memory
                .getRecentTurns(10)
                .map((t) => ({
                  role: t.role === "user" ? "user" as const : "assistant" as const,
                  content: t.content,
                })),
            },
          );
          return response;
        },
      }),
    ],
  });
}
