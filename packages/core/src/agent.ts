import { defaultMetrics, registerCallMetrics, type MetricsRegistry } from "./observability/metrics.js";
import { createCostTracker, type CostTracker } from "./observability/cost.js";
import {
  defaultInputBlockedText,
  defaultOutputBlockedText,
  runGuardrails,
} from "./guardrails/index.js";
import { EventEmitter } from "node:events";
import type {
  FelAgentConfig,
  Session,
  AudioChunk,
  AgentAction,
  AgentHooks,
  AgentTool,
  STTProvider,
  TTSProvider,
  ActionContext,
  InteractOptions,
  InteractResult,
  EmbeddingProvider,
  Transport,
} from "./types.js";
import { WebSocketTransport, type WebSocketTransportOptions } from "./transport/websocket.js";
import { WebRTCTransport, type WebRTCTransportOptions } from "./transport/webrtc.js";
import { TwilioTransport, type TwilioTransportOptions } from "./telephony/twilio-transport.js";
import { TwilioTransferProvider, type CallTransferProvider } from "./telephony/transfer.js";
import { createTwilioStreamTwiML, type TwilioStreamTwiMLOptions } from "./telephony/twiml.js";
import { SessionManager, createSessionManager } from "./session/index.js";
import { JEVEngine } from "./jev/engine.js";
import { OpenAIEmbeddingProvider } from "./jev/embeddings.js";
import { FastSemanticEmbeddingProvider } from "./jev/fast-embeddings.js";
import { ConversationMemory } from "./memory/context.js";
import { ToolRegistry } from "./tools/registry.js";
import { createFelonaTracer, type FelonaTracer } from "./observability/tracing.js";
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
import { AudioPreprocessor } from "./audio/preprocess.js";
import { describeLanguage } from "./i18n/language.js";
import { KnowledgeBase } from "./knowledge/kb.js";

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
  private transport: Transport;
  private readonly jev: JEVEngine;
  private readonly logger: CallLogger;
  private readonly tools: ToolRegistry;
  private readonly tracer: FelonaTracer;
  private readonly hooks: AgentHooks;
  private readonly sttProvider: STTProvider;
  private readonly ttsProvider: TTSProvider;
  private readonly vadOptions: NonNullable<FelAgentConfig["vad"]>;
  private readonly sttFlushTimeoutMs: number;
  private readonly audioEnabled: boolean;
  private readonly transferProvider: CallTransferProvider | null;

  /** Session manager for scaling, multi-turn state persistence, and concurrency limits */
  public readonly sessions: SessionManager;

  /**
   * Retrieval over the agent's own documentation.
   *
   * Always present so documents can be added at any point; retrieval returns
   * nothing until something is indexed. In-memory only — nothing is written
   * to disk.
   */
  public readonly knowledge: KnowledgeBase;

  // Active pipelines (one per session)
  private pipelines: Map<string, VoicePipeline> = new Map();
  // Session tracking for direct interactions
  private sessionMap: Map<string, { session: Session; memory: ConversationMemory }> = new Map();
  /**
   * In-flight `interact()` turns, keyed by session id.
   *
   * Turns on one session run one at a time so their memory writes cannot
   * interleave. Turns on *different* sessions stay concurrent.
   */
  private interactQueue: Map<string, Promise<void>> = new Map();
  /** Guards against a second `interact()` LRU eviction pass during setup. */
  private static readonly MAX_INTERACT_SESSIONS = 1000;

  /** Per-call start time, used to enforce a maximum call duration. */
  private callStartedAt: Map<string, number> = new Map();
  /**
   * Process-wide call counters.
   *
   * Exposed so a deployment can scrape them, and so a health endpoint can
   * report live call count without a separate metrics backend.
   */
  readonly metrics: MetricsRegistry = defaultMetrics;
  /**
   * Per-call usage and cost, when `cost` is configured.
   *
   * Present only with a price table: without prices there is nothing to
   * report but token counts, which the metrics registry already carries.
   */
  readonly costs: CostTracker | null = null;
  private callSweepTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  private initialized = false;
  private jevReady = false;
  private jevInitPromise: Promise<void> | null = null;

  constructor(config: FelAgentConfig) {
    super();
    registerCallMetrics(this.metrics);
    this.config = config;
    if (config.cost) {
      this.costs = createCostTracker({ prices: config.cost.prices, metrics: this.metrics });
      this.costs.onCallCost = config.cost.onCallCost;
    }
    this.hooks = config.hooks ?? {};

    // Initialize logger (only writes to disk if logDir is explicitly provided by user)
    this.logger = new CallLogger({
      logDir: config.logging?.logDir,
      level: config.logging?.level,
      enabled: config.logging?.enabled ?? Boolean(config.logging?.logDir),
      format: config.logging?.format,
    });

    // One tracer for the whole agent: the pipeline's turns and the tool calls
    // made inside them then share a trace, instead of being two unrelated ones.
    this.tracer = config.tracer ?? createFelonaTracer();

    // Initialize tools
    this.tools = new ToolRegistry();
    if (config.tools) {
      this.tools.registerAll(config.tools);
    }
    this.tools.setTracer(this.tracer);

    // Initialize providers (with safe fallbacks)
    this.sttProvider = this.createSTTProvider();
    this.ttsProvider = this.createTTSProvider();
    this.vadOptions = config.vad ?? {};
    this.sttFlushTimeoutMs = config.sttFlushTimeoutMs ?? 1500;
    this.audioEnabled = config.audio?.enabled ?? true;

    // A transfer provider exists only when credentials do. Otherwise
    // `ctx.transfer` stays undefined so a handler can say it cannot escalate,
    // rather than silently accepting a request that does nothing.
    this.transferProvider = config.transfers
      ? new TwilioTransferProvider({
          accountSid: config.transfers.accountSid,
          authToken: config.transfers.authToken,
          baseUrl: config.transfers.baseUrl,
        })
      : null;

    // Initialize JEV engine: custom object, named provider, or zero-config default
    const embeddingProvider = this.resolveEmbeddingProvider();
    this.jev = new JEVEngine({
      embeddingProvider,
      confidenceThreshold: config.jev?.confidenceThreshold ?? 0.35,
    });

    // Retrieval shares the routing embedder, so a custom provider improves
    // both without pulling in a second dependency.
    this.knowledge = new KnowledgeBase({
      embeddingProvider,
      topK: config.knowledge?.topK,
      minScore: config.knowledge?.minScore,
      chunk: config.knowledge?.chunk,
    });

    // Initialize session manager
    this.sessions = createSessionManager(config.sessions);
    this.sessions.on("sessionCreated", (s) => this.emit("sessionCreated", s));
    this.sessions.on("sessionEnded", (s) => this.emit("sessionEnded", s));
    this.sessions.on("concurrencyLimitReached", (active, max) => {
      this.metrics.increment("felona_calls_rejected_total");
      this.emit("concurrencyLimitReached", { active, max });
    });

    // Initialize transport
    this.transport = this.resolveInitialTransport();
  }

  /**
   * Resolve the configured embedding provider.
   *
   * The config type allows a plain string, so a name is resolved here rather
   * than being silently ignored (which previously fell through to the default
   * provider regardless of what was asked for).
   */
  private resolveEmbeddingProvider(): EmbeddingProvider {
    const configured = this.config.jev?.embeddingProvider;

    if (configured && typeof configured === "object") {
      return configured;
    }

    if (typeof configured === "string") {
      const name = configured.toLowerCase();

      if (name === "fast-semantic" || name === "fast") {
        return new FastSemanticEmbeddingProvider();
      }

      if (name === "openai") {
        const apiKey = this.config.jev?.embeddingApiKey;
        if (!apiKey) {
          throw new Error(
            'jev.embeddingProvider: "openai" requires jev.embeddingApiKey.',
          );
        }
        return new OpenAIEmbeddingProvider({ apiKey });
      }

      throw new Error(
        `Unknown jev.embeddingProvider "${configured}". ` +
          'Use "fast-semantic", "openai", or pass an EmbeddingProvider instance.',
      );
    }

    if (this.config.jev?.embeddingApiKey) {
      return new OpenAIEmbeddingProvider({ apiKey: this.config.jev.embeddingApiKey });
    }

    return new FastSemanticEmbeddingProvider();
  }

  /** Pick the transport from config, falling back to plain WebSocket. */
  private resolveInitialTransport(): Transport {
    const configured = this.config.transport;

    if (configured && typeof (configured as Transport).start === "function") {
      return configured as Transport;
    }

    if (configured && typeof configured === "object") {
      const opts = configured as WebSocketTransportOptions & { type?: string };

      if (opts.type === "twilio") {
        return new TwilioTransport({
          ...opts,
          // The agent owns the registry, so the transport's /metrics route
          // reports the same numbers the agent increments.
          metrics: (opts.metrics as MetricsRegistry | undefined) ?? this.metrics,
          // `authToken` on a Twilio transport config would be ambiguous with
          // the WebSocket one, so it is spelled `authTokenTwilio` here.
          authToken: opts.authToken ?? (opts as { authTokenTwilio?: string }).authTokenTwilio,
        } as TwilioTransportOptions);
      }

      if (opts.type === "webrtc") {
        // `authToken` is spelled the same here as on the WebSocket transport:
        // each is on its own transport config, so there is no ambiguity.
        const rtc = opts as WebRTCTransportOptions;
        return new WebRTCTransport({
          path: rtc.path,
          authToken: rtc.authToken,
          maxConnections: rtc.maxConnections,
          waitForIceGatheringMs: rtc.waitForIceGatheringMs,
          peerConfig: rtc.peerConfig,
          // Previously dropped on the floor: a config asking for sendonly
          // silently got a sendrecv peer, and `verifyClient` — an explicit
          // access control — was discarded without a word.
          direction: rtc.direction,
          verifyClient: rtc.verifyClient,
          disconnectedTimeoutMs: rtc.disconnectedTimeoutMs,
          metrics: rtc.metrics ?? this.metrics,
        });
      }

      if (opts.type && opts.type !== "websocket") {
        // Previously any unrecognised type silently produced a plain WebSocket
        // server, so a misconfigured deployment looked like it was working.
        throw new Error(
          `Unsupported transport type "${opts.type}". ` +
            'Use "websocket", "twilio", "webrtc", or pass a Transport instance.',
        );
      }

      return new WebSocketTransport({
        path: opts.path,
        authToken: opts.authToken,
        verifyClient: opts.verifyClient,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
        maxConnections: opts.maxConnections,
        metrics: opts.metrics ?? this.metrics,
      });
    }

    return new WebSocketTransport();
  }

  /**
   * Attach the agent's transport callbacks.
   *
   * Shared by `listen()` and `handleTwilioWebSocket()` so an agent attached to
   * a caller-supplied server behaves identically to one started with `listen()`.
   */
  private wireTransport(transport: Transport): void {
    // The handler type is `(session) => void`, so returning these async methods
    // directly would drop the promise. On Node 20+ an unhandled rejection
    // terminates the process, and these reject on any provider teardown error
    // — so one bad disconnect would kill every other call in flight.
    transport.onConnect((session) => {
      this.handleConnect(session).catch((error) =>
        this.reportAsyncFailure("handleConnect", error),
      );
    });
    transport.onDisconnect((session) => {
      this.handleDisconnect(session).catch((error) =>
        this.reportAsyncFailure("handleDisconnect", error),
      );
    });
    transport.onAudioChunk((sessionId, chunk) => this.handleAudio(sessionId, chunk));
    transport.onDTMF?.((sessionId, digit) => this.handleDTMF(sessionId, digit));
  }

  /**
   * Contains a failure from a fire-and-forget call site.
   *
   * There is no caller left to propagate to, so the only correct options are
   * to log it or crash. Log it, and make it visible.
   */
  private reportAsyncFailure(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.log("error", `${context} failed: ${detail}`);
    this.emitSafe("error", error instanceof Error ? error : new Error(detail));
  }

  /**
   * Ensure the JEV action space is embedded, exactly once.
   *
   * Required before any `decide()` call. Shared by `listen()`, `interact()`
   * and `handleTwilioWebSocket()` — the last of which previously skipped it
   * and failed on the first turn of every call.
   */
  private async ensureJEVInitialized(): Promise<void> {
    if (this.jevReady) return;
    if (this.jevInitPromise) return this.jevInitPromise;

    this.jevInitPromise = (async () => {
      this.logger.log("info", "Initializing JEV engine...");
      await this.jev.initialize(this.config.actions);
      this.jevReady = true;
      this.logger.log(
        "info",
        `JEV initialized with ${this.config.actions.length} actions`,
      );
    })();

    try {
      await this.jevInitPromise;
    } catch (error) {
      // Allow a later attempt to retry rather than caching the failure forever.
      this.jevInitPromise = null;
      throw error;
    }
  }

  /**
   * Emit only when someone is listening.
   *
   * `error` is special-cased by Node's EventEmitter: emitting it with no
   * registered listener throws and would crash the host process.
   */
  private emitSafe(event: string, ...args: unknown[]): void {
    if (this.listenerCount(event) > 0) {
      this.emit(event, ...args);
      return;
    }
    // An `error` with no listener is fatal in Node, and dropping any other
    // event loses information silently. Log either way.
    const detail = args[0] instanceof Error ? args[0].message : JSON.stringify(args[0]);
    this.logger.log("error", `Unobserved "${event}": ${detail}`);
  }

  /**
   * Set a custom transport instance (e.g., TwilioTransport).
   */
  setTransport(transport: Transport): this {
    this.transport = transport;
    return this;
  }

  /**
   * Start the agent — initialize JEV, start the transport, begin accepting calls.
   */
  async listen(options?: {
    port?: number;
    host?: string;
    path?: string;
    server?: import("http").Server | import("https").Server;
  }): Promise<void> {
    const configured = this.config.transport;
    const transportConfig =
      configured && typeof configured === "object" && !("start" in configured)
        ? (configured as {
            port?: number;
            host?: string;
            path?: string;
          })
        : undefined;

    const port = options?.port ?? transportConfig?.port ?? 8080;
    const host = options?.host ?? transportConfig?.host;
    const path = options?.path ?? transportConfig?.path;
    const server = options?.server;

    this.logger.log("info", `Starting Felona Voice agent: "${this.config.name}"`);

    // Step 1: Initialize JEV — embed all action descriptions
    await this.ensureJEVInitialized();

    // Step 2: Load predictor model if specified
    if (this.config.jev?.predictorModel) {
      await this.jev.loadPredictor(this.config.jev.predictorModel);
    }

    // Step 3: Wire up transport event handlers
    this.wireTransport(this.transport);

    // Step 4: Start the transport server
    await this.transport.start({ port, host, path, server });

    this.initialized = true;
    this.logger.log("info", `Agent "${this.config.name}" ready on port ${port}`);
    this.logger.log("info", `  STT: ${this.sttProvider.name}`);
    this.logger.log("info", `  TTS: ${this.ttsProvider.name}`);
    this.logger.log(
      "info",
      `  Language: ${describeLanguage(this.config.language)}`,
    );
    this.logger.log(
      "info",
      `  JEV: cold-start semantic routing (${this.jev.providerName}, no trained predictor)`,
    );
    this.logger.log(
      "info",
      `  Actions: ${this.config.actions.map((a) => a.id).join(", ")}`,
    );

    this.emit("ready", { port, host });
  }

  /**
   * Start a dedicated Twilio Telephony media stream server.
   * Automatically handles bidirectional audio and serves TwiML for phone number webhooks.
   */
  async listenTwilio(options?: {
    port?: number;
    host?: string;
    path?: string;
    webhookPath?: string | null;
    streamUrl?: string;
    greeting?: string;
    authToken?: string;
    publicUrl?: string;
    allowedHosts?: string[];
    server?: import("http").Server;
  }): Promise<void> {
    const port = options?.port ?? 8080;
    const host = options?.host ?? "0.0.0.0";
    const path = options?.path ?? "/media";

    this.transport = new TwilioTransport({
      port,
      host,
      path,
      webhookPath: options?.webhookPath,
      streamUrl: options?.streamUrl,
      greeting: options?.greeting,
      authToken: options?.authToken,
      publicUrl: options?.publicUrl,
      allowedHosts: options?.allowedHosts,
      server: options?.server,
    });

    await this.listen({ port, host, path, server: options?.server });
  }

  /**
   * Handle an existing WebSocket connection using the Twilio telephony pipeline.
   * Ideal for integrating phone agents into an existing Express/Fastify/Next.js/Hono server.
   *
   * Stays synchronous on purpose: the socket is live as soon as this returns,
   * so attaching the `message` listener must not be deferred behind a promise.
   * JEV initialization happens inside `handleConnect` instead.
   */
  handleTwilioWebSocket(ws: import("ws").WebSocket, req?: import("http").IncomingMessage): void {
    if (!(this.transport instanceof TwilioTransport)) {
      this.transport = new TwilioTransport();
      this.wireTransport(this.transport);
    }

    (this.transport as TwilioTransport).handleWebSocket(ws, req);
  }

  /**
   * Generate standard TwiML XML connecting an incoming or outgoing Twilio call to a media stream.
   */
  createTwilioTwiML(options: TwilioStreamTwiMLOptions): string {
    return createTwilioStreamTwiML(options);
  }

  /**
   * Starts the periodic sweep for over-long or abandoned calls.
   *
   * A call is normally torn down by a disconnect event, but a transport that
   * never delivers one (a half-open socket, a peer that vanished) would leave
   * its pipeline resident forever. The sweep is the backstop.
   */
  private startCallSweeper(): void {
    const interval = this.config.callSweepIntervalMs ?? 30_000;
    if (interval <= 0 || this.callSweepTimer) return;
    this.callSweepTimer = setInterval(() => this.sweepCalls(), interval);
    this.callSweepTimer.unref?.();
  }

  private stopCallSweeper(): void {
    if (!this.callSweepTimer) return;
    clearInterval(this.callSweepTimer);
    this.callSweepTimer = null;
  }

  /**
   * Ends any call that has exceeded the maximum duration.
   *
   * Also drops pipelines with no recorded start, which can only happen if
   * registration was interrupted — an entry the disconnect path would never
   * reach.
   */
  private sweepCalls(): void {
    const maxMs = this.config.maxCallDurationMs ?? 30 * 60 * 1000;
    if (maxMs > 0) {
      const now = Date.now();
      for (const [sessionId, startedAt] of this.callStartedAt) {
        if (now - startedAt < maxMs) continue;
        this.logger.log(
          "warn",
          `Ending call ${sessionId}: exceeded maxCallDurationMs (${maxMs}ms)`,
        );
        this.metrics.increment("felona_calls_timed_out_total");
        this.emitSafe("callTimeout", { sessionId, maxCallDurationMs: maxMs });
        this.endCall(sessionId, "max-duration").catch((error) =>
          this.reportAsyncFailure("call sweep teardown", error),
        );
      }
    }

    for (const sessionId of this.pipelines.keys()) {
      if (this.callStartedAt.has(sessionId)) continue;
      this.endCall(sessionId, "orphaned").catch((error) =>
        this.reportAsyncFailure("orphan teardown", error),
      );
    }
  }

  /**
   * Tears down one call's pipeline and session state.
   *
   * Shared by the disconnect handler and the sweeper so both paths release the
   * same resources exactly once.
   */
  private async endCall(sessionId: string, reason: string): Promise<void> {
    const pipeline = this.pipelines.get(sessionId);
    // Count the teardown only if this call was actually live, so a second
    // reap of the same id does not double-count.
    if (!this.pipelines.delete(sessionId)) return;
    this.callStartedAt.delete(sessionId);
    this.metrics.increment("felona_calls_ended_total");
    this.metrics.addGauge("felona_calls_active", -1);
    if (pipeline) await pipeline.stop();
    // Read the final tally before the record is dropped.
    const cost = this.costs?.finish(sessionId);
    if (cost && this.costs) {
      this.costs.onCallCost?.(sessionId, cost);
      this.emit("callCost", { sessionId, cost });
    }
    await this.sessions.endSession(sessionId).catch(() => {});
    if (this.pipelines.size === 0) this.stopCallSweeper();
    void reason;
  }

  /**
   * Stop the agent — shut down all pipelines and the transport.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopCallSweeper();
    this.logger.log("info", "Stopping agent...");

    // Stop all active pipelines
    for (const sessionId of [...this.pipelines.keys()]) {
      await this.endCall(sessionId, "shutdown");
    }
    this.pipelines.clear();
    this.callStartedAt.clear();

    // Stop transport
    await this.transport.stop();

    // Close session manager
    await this.sessions.close();

    this.initialized = false;
    this.logger.log("info", "Agent stopped");
    this.emit("stopped");
  }

  /**
   * Handle a new client connection — create a voice pipeline for this session.
   */
  private async handleConnect(session: Session): Promise<void> {
    this.logger.log("info", `New call: ${session.id}`);

    // The action space must be embedded before the first turn is routed. Doing
    // it here (rather than only in listen()) covers every entry point,
    // including handleTwilioWebSocket() on a caller-supplied server.
    try {
      await this.ensureJEVInitialized();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.log("error", `Cannot accept call ${session.id}: ${err.message}`);
      session.state = "ended";
      await this.hooks.onError?.(err, session);
      this.emitSafe("error", err);
      return;
    }

    // Register with the session manager. This is the single concurrency gate —
    // checking separately beforehand left a window where N+1 calls could pass
    // a maxConcurrent limit.
    try {
      await this.sessions.createSession({
        id: session.id,
        metadata: session.metadata,
        ttlMs: this.config.sessions?.ttlMs,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.log("error", `Cannot accept call ${session.id}: ${err.message}`);
      const stats = await this.sessions.getStats();
      this.emit("concurrencyLimitReached", stats);
      session.state = "ended";
      await this.hooks.onError?.(err, session);
      return;
    }

    // Create per-session memory
    const memory = new ConversationMemory();

    // Create a new VAD instance per session (has internal state)
    const vad = new EnergyVAD(this.vadOptions);

    // Create a new preprocessor per session (carries filter/noise/gain state)
    const preprocessor = this.audioEnabled
      ? new AudioPreprocessor({
          sampleRate: 16000,
          bitDepth: 16,
          highPassHz: this.config.audio?.highPassHz,
          noiseGate: this.config.audio?.noiseGate,
          targetRms: this.config.audio?.targetRms,
          maxGain: this.config.audio?.maxGain,
        })
      : null;

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
      sttFlushTimeoutMs: this.sttFlushTimeoutMs,
      preprocessor,
      endpointing: this.config.endpointing,
      interruption: this.config.interruption,
      preemptive: this.config.preemptive,
      hooksMode: this.config.hooksMode,
      guardrails: this.config.guardrails,
      voicemail: this.config.voicemail,
      allowPromptOverride: this.config.allowPromptOverride,
      countMetric: (name, value, labels) => this.metrics.increment(name, value, labels),
      reportLLMUsage: (usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }) => {
        this.costs?.addLLMUsage(session.id, usage);
      },
      reportUsage: (usage: { sttBytes: number; ttsBytes: number; synthesizedChars: number }) => {
        if (!this.costs) return;
        // 16 kHz, 16-bit mono is 32_000 bytes per second; telephony arrives at
        // 8 kHz μ-law, which the codec expands to the same 16 kHz PCM.
        this.costs.addAudioSeconds(
          session.id,
          usage.sttBytes / 32_000,
          "inbound",
        );
        this.costs.addSynthesizedCharacters(session.id, usage.synthesizedChars);
      },
      dtmf: this.config.dtmf,
      language: this.config.language,
      transferProvider: this.transferProvider,
      knowledge: this.knowledge,
      tracer: this.tracer,
      analysis: this.config.analysis,
      sendAudio: (chunk) => this.transport.sendAudio(session.id, chunk),
      clearAudio: () =>
        this.transport.clearAudio ? this.transport.clearAudio(session.id) : Promise.resolve(),
      sessionManager: this.sessions,
    });

    // Forward pipeline events
    pipeline.on("transcript", (data) =>
      this.emit("transcript", { sessionId: session.id, ...data }),
    );
    pipeline.on("error", (error) =>
      this.emitSafe("error", { sessionId: session.id, error }),
    );
    pipeline.on("sttError", (error) =>
      this.emitSafe("sttError", { sessionId: session.id, error }),
    );
    pipeline.on("bargeIn", () =>
      this.emit("bargeIn", { sessionId: session.id }),
    );
    pipeline.on("falseInterruption", () =>
      this.emit("falseInterruption", { sessionId: session.id }),
    );
    pipeline.on("turnComplete", () => this.metrics.increment("felona_turns_total"));
    pipeline.on("turnFailed", () => this.metrics.increment("felona_turn_errors_total"));
    pipeline.on("sttError", () =>
      this.metrics.increment("felona_stt_errors_total", 1, {
        provider: this.sttProvider.name,
      }),
    );
    pipeline.on("ttsError", () =>
      this.metrics.increment("felona_tts_errors_total", 1, {
        provider: this.ttsProvider.name,
      }),
    );
    pipeline.on("bargeIn", () => this.metrics.increment("felona_barge_ins_total"));
    pipeline.on("callAnalysis", (analysis) => this.emit("callAnalysis", analysis));
    pipeline.on("dtmf", (event) => this.emit("dtmf", event));
    pipeline.on("dtmfPartial", (event) => this.emit("dtmfPartial", event));
    pipeline.on("dtmfEntry", (event) => this.emit("dtmfEntry", event));

    this.pipelines.set(session.id, pipeline);
    this.callStartedAt.set(session.id, Date.now());
    this.startCallSweeper();
    this.metrics.increment("felona_calls_started_total");
    this.metrics.addGauge("felona_calls_active", 1);

    try {
      await pipeline.start();
    } catch (error) {
      // Opening the speech stream failed (usually a missing API key). Tear
      // everything down so the session does not leak a concurrency slot.
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.log("error", `Failed to start call ${session.id}: ${err.message}`);

      this.pipelines.delete(session.id);
      await this.sessions.endSession(session.id);
      session.state = "ended";
      await this.hooks.onError?.(err, session);
      this.emitSafe("error", err);
      return;
    }

    this.emit("callStarted", session);
  }

  /**
   * Handle a client disconnection — stop and clean up the pipeline.
   */
  private async handleDisconnect(session: Session): Promise<void> {
    this.logger.log("info", `Call ended: ${session.id}`);
    // Same teardown path as the sweeper, so a disconnect and a max-duration
    // reap release exactly the same resources.
    await this.endCall(session.id, "disconnect");
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

  /** Route a keypad digit to the session's pipeline. */
  private handleDTMF(sessionId: string, digit: string): void {
    this.pipelines.get(sessionId)?.handleDTMF(digit);
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
          noiseReduction: this.config.stt?.noiseReduction as
            | "off"
            | "light"
            | "medium"
            | "heavy"
            | undefined,
          speechEnhancement: this.config.stt?.speechEnhancement as
            | "disable"
            | "quality"
            | undefined,
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
          noiseReduction: this.config.stt?.noiseReduction as
            | "off"
            | "light"
            | "heavy"
            | undefined,
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
  /**
   * Runs one text turn, serialised against other turns on the same session.
   *
   * Two concurrent `interact()` calls on a session would interleave: both
   * build their context from the same memory, both await JEV, and then both
   * append — leaving the conversation with one turn's answer missing its
   * question. Chaining on a per-session promise makes each turn observe the
   * previous one's result.
   */
  async interact(input: string | InteractOptions): Promise<InteractResult> {
    const opts: InteractOptions = typeof input === "string" ? { userMessage: input } : input;
    const sessionId = opts.sessionId ?? "default-session";

    const previous = this.interactQueue.get(sessionId) ?? Promise.resolve();
    // The queue entry must not inherit a rejection, or one failed turn would
    // poison every later turn on that session.
    const run = previous
      .catch(() => {})
      .then(() => this.runInteractTurn(sessionId, opts));

    const queued: Promise<void> = run.then(
      () => {},
      () => {},
    );
    this.interactQueue.set(sessionId, queued);

    // Release the slot once this turn settles so a long-lived session does not
    // accumulate one pending promise per turn. Guarded so a turn that queued
    // behind us does not have its successor dropped from the chain.
    void queued.then(() => {
      if (this.interactQueue.get(sessionId) === queued) {
        this.interactQueue.delete(sessionId);
      }
    });

    return run;
  }

  /**
   * Stand-in action returned when a guardrail blocks.
   *
   * `InteractResult.action` is a required `AgentAction`, so a blocked turn
   * still has to name something. A distinct id means a caller can tell a
   * blocked turn from a real route without inspecting the text.
   */
  private static readonly BLOCKED_ACTION: AgentAction = {
    id: "__blocked__",
    description: "Turn blocked by a guardrail before it was routed",
    handler: async () => "",
  };

  private async runInteractTurn(
    sessionId: string,
    opts: InteractOptions,
  ): Promise<InteractResult> {
    const startTime = performance.now();

    // 1. Ensure JEV is initialized
    await this.ensureJEVInitialized();

    // 2. Resolve session & memory
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
      this.evictOldestSessions();
    } else {
      // Refresh insertion order so eviction is genuinely least-recently-used.
      this.sessionMap.delete(sessionId);
      this.sessionMap.set(sessionId, sessionEntry);
    }

    const { session, memory } = sessionEntry;

    // Input guardrail, before routing, retrieval or any tool call.
    //
    // `interact()` bypasses the voice pipeline, so without this an operator who
    // configured guardrails and exposed interact() over HTTP would believe they
    // were protected on a path where they are not.
    const inputVerdict = await runGuardrails(this.config.guardrails?.input, {
      text: opts.userMessage,
      session,
    });
    if (inputVerdict.blocked) {
      this.logger.log(
        "warn",
        `interact() input blocked by guardrail: ${inputVerdict.reason ?? "unspecified"}`,
      );
      this.metrics.increment("felona_guardrail_blocks_total", 1, { side: "input" });
      this.emitSafe("guardrailBlocked", {
        sessionId,
        side: "input",
        reason: inputVerdict.reason,
      });
      return {
        text:
          inputVerdict.replacement ??
          this.config.guardrails?.onInputBlocked ??
          defaultInputBlockedText(),
        action: FelAgent.BLOCKED_ACTION,
        confidence: 0,
        candidates: [],
        slots: memory.getSlots(),
        telemetry: { latencyMs: 0, actionSpaceSize: this.config.actions.length, embeddingModel: this.jev.providerName },
      };
    }

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

    // Output guardrail, before the reply is returned to the caller. The voice
    // path checks this before speaking; interact() returns text directly, so
    // the same control has to be applied here.
    const outputVerdict = await runGuardrails(this.config.guardrails?.output, {
      text: responseText,
      session,
      actionId: match.action.id,
    });
    if (outputVerdict.blocked) {
      this.logger.log(
        "warn",
        `interact() output blocked by guardrail: ${outputVerdict.reason ?? "unspecified"}`,
      );
      this.metrics.increment("felona_guardrail_blocks_total", 1, { side: "output" });
      this.emitSafe("guardrailBlocked", {
        sessionId,
        side: "output",
        reason: outputVerdict.reason,
      });
      responseText =
        outputVerdict.replacement ??
        this.config.guardrails?.onOutputBlocked ??
        defaultOutputBlockedText();
    }

    // Record agent turn in memory
    memory.addTurn({
      role: "agent",
      content: responseText,
      timestampMs: Date.now(),
      actionId: match.action.id,
      confidence: match.confidence,
    });

    const latencyMs = Number((performance.now() - startTime).toFixed(2));

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
   * Drop the least-recently-used interact() sessions.
   *
   * `interact()` sessions live for the lifetime of the process — a long-running
   * server would otherwise accumulate one memory per distinct sessionId.
   */
  private evictOldestSessions(): void {
    while (this.sessionMap.size > FelAgent.MAX_INTERACT_SESSIONS) {
      const oldest = this.sessionMap.keys().next();
      if (oldest.done) return;
      this.sessionMap.delete(oldest.value);
    }
  }

  /**
   * Discard in-memory state for an `interact()` session.
   * Nothing is persisted — this only frees memory.
   */
  endSession(sessionId: string): boolean {
    return this.sessionMap.delete(sessionId);
  }

  /** Discard all `interact()` session state. */
  clearSessions(): void {
    this.sessionMap.clear();
  }

  /** Number of live `interact()` sessions held in memory. */
  get interactSessionCount(): number {
    return this.sessionMap.size;
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
   * The agent's tool registry.
   *
   * Exposed so tools can be added after construction — which is what an MCP
   * server needs, since listing one is asynchronous and `build()` is not.
   */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /**
   * Add tools to a running agent.
   *
   * Duplicate names throw rather than replacing, so a typo cannot silently
   * change which implementation answers on a live call.
   */
  addTools(toolList: AgentTool[]): void {
    this.tools.registerAll(toolList);
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
