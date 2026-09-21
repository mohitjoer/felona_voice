import { EventEmitter } from "node:events";
import type {
  FelAgentConfig,
  Session,
  AudioChunk,
  AgentAction,
  AgentHooks,
  STTProvider,
  TTSProvider,
  ActionContext,
  InteractOptions,
  InteractResult,
  EmbeddingProvider,
} from "./types.js";
import { WebSocketTransport } from "./transport/websocket.js";
import { JEVEngine } from "./jev/engine.js";
import { OpenAIEmbeddingProvider } from "./jev/embeddings.js";
import { FastSemanticEmbeddingProvider } from "./jev/fast-embeddings.js";
import { ConversationMemory } from "./memory/context.js";
import { ToolRegistry } from "./tools/registry.js";
import { CallLogger } from "./analytics/logger.js";
import { VoicePipeline } from "./pipeline.js";
import {
  drawAscii,
  drawMermaid,
  drawMarkdown,
  toMermaidLiveUrl,
  visualizeGraph,
  type GraphData,
  type VisualizeOptions,
  type VisualizeResult,
} from "./graph/visualize.js";

// Provider imports
import { DeepgramSTT } from "./stt/deepgram.js";
import { WhisperSTT } from "./stt/whisper.js";
import { AssemblyAISTT } from "./stt/assemblyai.js";
import { AzureSTT } from "./stt/azure.js";
import { GoogleSTT } from "./stt/google.js";

import { ElevenLabsTTS } from "./tts/eleven-labs.js";
import { DeepgramTTS } from "./tts/deepgram.js";
import { OpenAITTS } from "./tts/openai.js";
import { CartesiaTTS } from "./tts/cartesia.js";
import { AzureTTS } from "./tts/azure.js";
import { PollyTTS } from "./tts/polly.js";
import { LMNTTTS } from "./tts/lmnt.js";

import { EnergyVAD } from "./vad/energy.js";

/**
 * FelAgent — The main entry point for building a voice agent with Felona Voice.
 *
 * Usage:
 * ```typescript
 * const agent = new FelAgent({
 *   name: "Support Bot",
 *   systemPrompt: "You are a helpful support agent.",
 *   actions: [ ... ],
 * });
 *
 * // Directly interact (text/simulation):
 * const reply = await agent.interact("where is my order?");
 *
 * // Or listen on WebSocket for live audio calls:
 * agent.listen({ port: 8080 });
 * ```
 */
export class FelAgent extends EventEmitter {
  private readonly config: FelAgentConfig;
  private transport: WebSocketTransport;
  private readonly jev: JEVEngine;
  private readonly logger: CallLogger;
  private readonly tools: ToolRegistry;
  private readonly hooks: AgentHooks;
  private readonly sttProvider: STTProvider;
  private readonly ttsProvider: TTSProvider;
  private readonly vadProvider: EnergyVAD;

  // Active pipelines (one per session)
  private pipelines: Map<string, VoicePipeline> = new Map();
  // Session tracking for direct interactions
  private sessionMap: Map<string, { session: Session; memory: ConversationMemory }> = new Map();

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

    // Initialize providers (with safe fallbacks)
    this.sttProvider = this.createSTTProvider();
    this.ttsProvider = this.createTTSProvider();
    this.vadProvider = new EnergyVAD();

    // Initialize JEV engine: custom object, OpenAI, or zero-config FastSemanticEmbeddingProvider
    let embeddingProvider: EmbeddingProvider;
    if (
      typeof config.jev?.embeddingProvider === "object" &&
      config.jev.embeddingProvider !== null
    ) {
      embeddingProvider = config.jev.embeddingProvider as EmbeddingProvider;
    } else if (config.jev?.embeddingApiKey) {
      embeddingProvider = new OpenAIEmbeddingProvider({
        apiKey: config.jev.embeddingApiKey,
      });
    } else {
      embeddingProvider = new FastSemanticEmbeddingProvider();
    }

    this.jev = new JEVEngine({
      embeddingProvider,
      confidenceThreshold: config.jev?.confidenceThreshold ?? 0.35,
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
      jev: this.jev,
      memory,
      tools: this.tools,
      logger: this.logger,
      hooks: this.hooks,
      systemPrompt:
        this.config.systemPrompt ??
        "You are a helpful, conversational AI voice assistant.",
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
  private createSTTProvider(): STTProvider {
    if (
      typeof this.config.stt === "object" &&
      this.config.stt !== null &&
      "createStream" in this.config.stt
    ) {
      return this.config.stt as STTProvider;
    }
    const prov = (this.config.stt?.provider ?? "deepgram").toLowerCase();
    const apiKey = (this.config.stt?.apiKey as string) ?? "";

    switch (prov) {
      case "whisper":
      case "openai":
        return new WhisperSTT({
          apiKey,
          model: this.config.stt?.model as string | undefined,
          language: this.config.stt?.language as string | undefined,
        });
      case "assemblyai":
      case "assembly-ai":
        return new AssemblyAISTT({
          apiKey,
          sampleRate: (this.config.stt?.sampleRate as number) ?? 16000,
        });
      case "azure":
        return new AzureSTT({
          apiKey,
          region: (this.config.stt?.region as string) ?? "eastus",
          language: this.config.stt?.language as string | undefined,
        });
      case "google":
        return new GoogleSTT({
          apiKey,
          languageCode: this.config.stt?.language as string | undefined,
          model: this.config.stt?.model as string | undefined,
        });
      case "deepgram":
      default:
        return new DeepgramSTT({
          apiKey,
          model: this.config.stt?.model as string | undefined,
        });
    }
  }

  /** Create TTS provider based on config */
  private createTTSProvider(): TTSProvider {
    if (
      typeof this.config.tts === "object" &&
      this.config.tts !== null &&
      "synthesize" in this.config.tts
    ) {
      return this.config.tts as TTSProvider;
    }
    const prov = (this.config.tts?.provider ?? "").toLowerCase();
    const apiKey = (this.config.tts?.apiKey as string) ?? "";
    const voice =
      (this.config.tts?.voice as string) ??
      (this.config.tts?.model as string);

    switch (prov) {
      case "openai":
        return new OpenAITTS({
          apiKey,
          voice,
          model: this.config.tts?.model as string | undefined,
        });
      case "cartesia":
        return new CartesiaTTS({
          apiKey,
          voice,
          modelId: this.config.tts?.modelId as string | undefined,
        });
      case "azure":
        return new AzureTTS({
          apiKey,
          region: (this.config.tts?.region as string) ?? "eastus",
          voice,
          language: this.config.tts?.language as string | undefined,
        });
      case "polly":
      case "aws":
        return new PollyTTS({
          apiKey,
          region: (this.config.tts?.region as string) ?? "us-east-1",
          voice,
        });
      case "lmnt":
        return new LMNTTTS({
          apiKey,
          voice,
        });
      case "deepgram":
        return new DeepgramTTS({
          apiKey,
          model: voice,
        });
      case "elevenlabs":
      case "eleven-labs":
      default:
        return new ElevenLabsTTS({
          apiKey,
          voice,
        });
    }
  }


  /**
   * Directly interact with the agent (simulate a single turn without WebSocket audio).
   *
   * Perfect for unit testing, HTTP/REST API endpoints, Next.js server actions,
   * CLI tools, or text-based debugging.
   *
   * @example
   * ```typescript
   * const reply = await agent.interact("where is my order?");
   * console.log(reply.text);
   * console.log(reply.action.id);
   * ```
   */
  async interact(input: string | InteractOptions): Promise<InteractResult> {
    const opts: InteractOptions = typeof input === "string" ? { userMessage: input } : input;
    const startTime = performance.now();

    // 1. Ensure JEV is initialized
    if (!this.jev.isInitialized) {
      await this.jev.initialize(this.config.actions);
    }

    // 2. Resolve session & memory
    const sessionId = opts.sessionId ?? "default-session";
    let sessionEntry = this.sessionMap.get(sessionId);
    if (!sessionEntry) {
      const session: Session = {
        id: sessionId,
        startedAt: new Date(),
        metadata: {},
        state: "active",
      };
      const memory = new ConversationMemory({ maxTurns: 30 });
      sessionEntry = { session, memory };
      this.sessionMap.set(sessionId, sessionEntry);
    }

    const { session, memory } = sessionEntry;

    // Apply custom slots if provided
    if (opts.slots) {
      for (const [k, v] of Object.entries(opts.slots)) {
        memory.setSlot(k, v);
      }
    }

    // Populate history if provided explicitly
    if (opts.history && opts.history.length > 0) {
      for (const h of opts.history) {
        memory.addTurn({
          role: h.role === "user" ? "user" : "agent",
          content: h.content,
          timestampMs: Date.now(),
          actionId: h.actionId,
        });
      }
    }

    // Record user turn in memory
    memory.addTurn({
      role: "user",
      content: opts.userMessage,
      timestampMs: Date.now(),
    });

    // 3. Build ConversationContext
    const context = memory.buildContext(
      session,
      this.config.systemPrompt ?? "You are a helpful voice assistant.",
      opts.userMessage
    );

    // 4. Run JEV Decision
    const match = await this.jev.decide(context);

    // 5. Execute Action Handler
    let responseText = "";
    try {
      const actionContext: ActionContext = {
        conversation: context,
        tools: this.tools,
        memory,
        session,
      };
      responseText = await match.action.handler(actionContext);
    } catch (err) {
      this.logger.log("error", `Action handler failed for "${match.action.id}": ${err}`);
      responseText = "I encountered an issue processing that request.";
    }

    // Record agent turn in memory
    memory.addTurn({
      role: "agent",
      content: responseText,
      timestampMs: Date.now(),
      actionId: match.action.id,
      confidence: match.confidence,
    });

    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

    return {
      text: responseText,
      action: match.action,
      confidence: Number(match.confidence.toFixed(4)),
      candidates: match.candidates.map((c) => ({
        actionId: c.actionId,
        score: Number(c.score.toFixed(4)),
      })),
      slots: memory.getSlots(),
      telemetry: {
        latencyMs,
        actionSpaceSize: this.config.actions.length,
        embeddingModel: this.jev.providerName,
      },
    };
  }

  /**
   * Run a multi-turn conversation simulation.
   */
  async simulate(turns: string[], sessionId?: string): Promise<InteractResult[]> {
    const results: InteractResult[] = [];
    const sid = sessionId ?? "default-session";
    for (const turn of turns) {
      const res = await this.interact({ userMessage: turn, sessionId: sid });
      results.push(res);
    }
    return results;
  }

  /** Access default conversation memory manager */
  get memory(): ConversationMemory {
    let entry = this.sessionMap.get("default-session");
    if (!entry) {
      entry = {
        session: { id: "default-session", startedAt: new Date(), metadata: {}, state: "active" },
        memory: new ConversationMemory({ maxTurns: 30 }),
      };
      this.sessionMap.set("default-session", entry);
    }
    return entry.memory;
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

  /**
   * Get graph data representing the agent's action space.
   */
  getGraph(): GraphData {
    return {
      name: this.config.name,
      nodes: this.config.actions.map((a) => ({
        id: a.id,
        description: a.description,
      })),
      edges: [],
      entryPoint: this.config.actions.length > 0 ? this.config.actions[0].id : undefined,
    };
  }

  /**
   * Render an ASCII diagram of the agent's actions in the terminal.
   */
  drawAscii(options?: { title?: string }): string {
    return drawAscii(this.getGraph(), options);
  }

  /**
   * Export the agent's action space as a Mermaid flowchart.
   */
  drawMermaid(): string {
    return drawMermaid(this.getGraph());
  }

  /**
   * Export the agent's action space as Markdown documentation.
   */
  drawMarkdown(options?: { title?: string }): string {
    return drawMarkdown(this.getGraph(), options);
  }

  /**
   * Get a direct link to view the diagram in Mermaid Live Editor.
   */
  toMermaidLiveUrl(): string {
    return toMermaidLiveUrl(this.drawMermaid());
  }

  /**
   * Visualize the agent in terminal (ASCII), Mermaid, or launch the interactive HTML visualizer.
   */
  async visualize(options?: VisualizeOptions): Promise<VisualizeResult> {
    return visualizeGraph(this.getGraph(), options);
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
 */
export function quickStart(config?: {
  name?: string;
  stt?: { provider: string; apiKey: string };
  tts?: { provider: string; apiKey: string; voice?: string };
  systemPrompt?: string;
  onRespond?: (utterance: string) => Promise<string> | string;
}): FelAgent {
  return new FelAgent({
    name: config?.name ?? "Felona Agent",
    systemPrompt:
      config?.systemPrompt ??
      "You are a helpful, friendly voice assistant. Keep your responses concise and conversational.",
    stt: config?.stt,
    tts: config?.tts,
    actions: [
      defineAction({
        id: "respond",
        description:
          "Respond to the user's message helpfully and conversationally",
        handler: async (ctx) => {
          if (config?.onRespond) {
            return config.onRespond(ctx.conversation.currentUtterance);
          }
          return `I heard you say: "${ctx.conversation.currentUtterance}". How else can I assist you?`;
        },
      }),
    ],
  });
}
