/**
 * Core type definitions for Felona Voice.
 *
 * These types define the contracts between all modules in the framework.
 * Every provider, engine, and component implements interfaces defined here.
 */

import type { TransferRequest } from "./telephony/transfer.js";
import type { KnowledgeChunk } from "./knowledge/kb.js";
import type { FelonaTracer } from "./observability/tracing.js";
import type { AnalyzeOptions } from "./analytics/call-analysis.js";
import type { GuardrailOptions } from "./guardrails/index.js";
import type { CallCost, PriceTable } from "./observability/cost.js";
import type { VoicemailOptions } from "./voicemail/index.js";

// ─── Audio ──────────────────────────────────────────────────────────────────

/** Raw audio chunk flowing through the pipeline */
export interface AudioChunk {
  /** PCM audio data (16-bit, 16kHz mono by default) */
  data: Buffer;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels (1 = mono) */
  channels: number;
  /** Bit depth (16 = PCM16) */
  bitDepth: number;
  /** Timestamp in milliseconds (relative to session start) */
  timestampMs: number;
}

/** Default audio format used throughout the pipeline */
export const DEFAULT_AUDIO_FORMAT = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
} as const;

// ─── Session ────────────────────────────────────────────────────────────────

/** Represents a single voice call/session */
export interface Session {
  /** Unique session identifier */
  id: string;
  /** When the session started */
  startedAt: Date;
  /** Arbitrary metadata attached to this session */
  metadata: Record<string, unknown>;
  /** Current session state */
  state: SessionState;
}

export type SessionState = "connecting" | "active" | "paused" | "ended";

/** Complete session record persisted in the SessionStore */
export interface SessionRecord {
  /** Unique session ID (e.g. streamSid or UUID) */
  id: string;
  /** When session was created (epoch ms) */
  createdAt: number;
  /** Last activity timestamp (epoch ms) */
  lastActiveAt: number;
  /** Current state */
  state: SessionState;
  /** Custom metadata (telephony details, headers, caller IDs, etc.) */
  metadata: Record<string, unknown>;
  /** Memory slots / state values attached to this session */
  slots: Record<string, unknown>;
  /** Conversation history turns */
  turns: ConversationTurn[];
  /** Optional TTL in milliseconds */
  ttlMs?: number;
}

/** Interface for pluggable Session Stores (Memory, Redis, DynamoDB, etc.) */
export interface SessionStore {
  /** Retrieve a session record by ID */
  get(id: string): Promise<SessionRecord | null>;
  /** Persist or update a session record */
  set(id: string, record: SessionRecord): Promise<void>;
  /** Delete a session record */
  delete(id: string): Promise<boolean>;
  /** Touch a session to update its lastActiveAt timestamp */
  touch(id: string): Promise<void>;
  /** List session records with optional filter */
  list(filter?: { state?: SessionState }): Promise<SessionRecord[]>;
  /** Clear all records */
  clear(): Promise<void>;
  /** Close / disconnect store */
  close?(): Promise<void>;
}

/** Configuration options for session management */
export interface SessionManagerOptions {
  /** Pluggable store instance (defaults to MemorySessionStore) */
  store?: SessionStore;
  /**
   * Maximum concurrent active sessions.
   *
   * Default: 100. Each live call holds a pipeline, a VAD, a preprocessor, an
   * STT socket and conversation memory, so an unbounded default means one
   * process will accept as many calls as the network offers and then fall over
   * on memory and CPU. Set this to your per-instance capacity.
   */
  maxConcurrent?: number;
  /** Session inactivity timeout / TTL in milliseconds (default: 30 minutes) */
  ttlMs?: number;
  /** Cleanup check interval for expired sessions in milliseconds (default: 60s) */
  cleanupIntervalMs?: number;
}

/** Session statistics for monitoring & health checks */
export interface SessionStats {
  activeCount: number;
  totalCreated: number;
  maxConcurrent: number;
  totalExpired: number;
}

// ─── Conversation ───────────────────────────────────────────────────────────

/** A single turn in the conversation */
export interface ConversationTurn {
  /** Who spoke */
  role: "user" | "agent";
  /** The transcribed/generated text */
  content: string;
  /** When this turn occurred */
  timestampMs: number;
  /** If agent turn, which action was selected by JEV */
  actionId?: string;
  /** JEV confidence score for the selected action (0-1) */
  confidence?: number;
}

/** Full conversation context passed to the JEV engine */
export interface ConversationContext {
  /** The current session */
  session: Session;
  /** All turns so far */
  turns: ConversationTurn[];
  /** The latest user utterance (may be partial for streaming) */
  currentUtterance: string;
  /** Extracted slots/entities */
  slots: Record<string, unknown>;
  /** System prompt for this agent */
  systemPrompt: string;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** An action the agent can take, as defined by the developer */
export interface AgentAction {
  /** Unique identifier for this action */
  id: string;
  /** Human-readable description — this gets embedded by JEV */
  description: string;
  /**
   * Handler executed when JEV selects this action.
   * Returns the text the agent should speak.
   */
  handler: (ctx: ActionContext) => Promise<string>;
  /** Optional: custom metadata for analytics/logging */
  metadata?: Record<string, unknown>;
}

/**
 * The slice of the session manager exposed to action handlers.
 *
 * Declared here (rather than importing `SessionManager`) so that `types.ts`
 * stays dependency-free and handlers can be written against a narrow
 * contract. `SessionManager` satisfies this structurally.
 */
export interface SessionAccessor {
  /** Read a slot value. */
  getSlot(id: string, key: string): Promise<unknown>;
  /** Write a slot value. */
  setSlot(id: string, key: string, value: unknown): Promise<void>;
  /** Read all slots. */
  getSlots(id: string): Promise<Record<string, unknown>>;
}

/** Context passed to action handlers */
export interface ActionContext {
  /**
   * Aborted when the caller interrupts mid-turn.
   *
   * Pass it to anything slow and cancellable — an LLM stream, a tool call, a
   * database round trip. Without it, work started for a turn the caller just
   * interrupted still runs to completion: the tokens are billed and the latency
   * is paid, but the result is discarded because the agent has stopped
   * speaking.
   *
   * This is the difference between a barge-in costing one already-streamed
   * sentence and a barge-in costing a full completion.
   */
  signal?: AbortSignal;
  /** The full conversation context */
  conversation: ConversationContext;
  /** Tool executor for calling external tools */
  tools: ToolExecutor;
  /** Conversation memory manager */
  memory: MemoryManager;
  /** The current session */
  session: Session;
  /** Session manager for multi-turn slot persistence & scaling */
  sessions?: SessionAccessor;
  /**
   * Reports token usage for this turn, so cost tracking can attribute it.
   *
   * A handler that calls an LLM has to say what it used: the pipeline cannot
   * see inside the provider. Without this the largest single cost driver in a
   * voice agent is unmeasured.
   */
  reportUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  /**
   * Replaces the system prompt for subsequent turns.
   *
   * Takes effect from the next turn; the turn in flight still answers under the
   * prompt it began with. Omitted when the agent's prompt is fixed.
   */
  setSystemPrompt?: (prompt: string) => void;
  /**
   * Ends the call at the transport level.
   *
   * The telephony-agnostic way for a handler to hang up: a voicemail
   * detector, an after-hours rule, or a compliance stop. Omitted when the
   * transport cannot end a call.
   */
  hangup?: () => Promise<void>;
  /** Keypad digits collected so far for this turn, if any. */
  dtmf?: string;
  /**
   * Search the agent's knowledge base.
   *
   * Omitted when no knowledge base is configured, so a handler can tell
   * "no knowledge base" from "nothing found".
   */
  knowledge?: {
    search: (
      query: string,
      options?: { topK?: number; minScore?: number },
    ) => Promise<KnowledgeChunk[]>;
  };

  /**
   * Hand the live call to a human or another line.
   *
   * Staged rather than immediate: the transfer runs after the handler's
   * returned text has finished playing, so a warm transfer's introduction is
   * actually heard before the line changes. Without this, an agent that says
   * "connecting you now" gets cut off mid-sentence.
   */
  transfer?: (request: TransferRequest) => void;
}

/** Result of JEV action matching */
export interface ActionMatch {
  /** The matched action */
  action: AgentAction;
  /** Confidence score (0-1) — cosine similarity or predictor confidence */
  confidence: number;
  /** All candidates with their scores, sorted descending */
  candidates: Array<{ actionId: string; score: number }>;
}

// ─── Transport ──────────────────────────────────────────────────────────────

/** Transport layer interface — handles audio I/O */
export interface Transport {
  /** Start listening for connections */
  start(options: TransportOptions): Promise<void>;
  /** Stop the transport */
  stop(): Promise<void>;
  /**
   * Optional: tear down a single session, leaving the transport and every
   * other call running.
   *
   * Distinct from `stop()`, which is process-wide. Anything that ends one call
   * rather than the whole service must use this: calling `stop()` to hang up
   * one caller drops every other caller on the process and shuts the server
   * down. Transports that can address an individual session should implement
   * it; those that cannot leave it undefined and the caller falls back.
   */
  closeSession?(sessionId: string): Promise<void>;
  /** Register handler for incoming audio */
  onAudioChunk(handler: (sessionId: string, chunk: AudioChunk) => void): void;
  /** Register handler for new connections */
  onConnect(handler: (session: Session) => void): void;
  /** Register handler for disconnections */
  onDisconnect(handler: (session: Session) => void): void;
  /** Send audio to a specific session */
  sendAudio(sessionId: string, chunk: AudioChunk): Promise<void>;
  /** Optional: clear queued audio on telephony/mobile buffer (e.g. Twilio barge-in) */
  clearAudio?(sessionId: string): Promise<void>;
  /**
   * Optional: keypad digits pressed by the caller.
   *
   * Only telephony transports can supply these — tones are not speech, so they
   * never reach the STT stream.
   */
  onDTMF?(handler: (sessionId: string, digit: string) => void): void;
}

export interface TransportOptions {
  port: number;
  host?: string;
  path?: string;
  server?: import("http").Server | import("https").Server;
}

// ─── STT (Speech-to-Text) ──────────────────────────────────────────────────

/** Speech-to-Text provider interface */
export interface STTProvider {
  /** Provider name (e.g., "deepgram", "whisper") */
  readonly name: string;
  /** Start a streaming recognition session */
  createStream(options?: STTStreamOptions): STTStream;
}

export interface STTStreamOptions {
  /** Language code (e.g., "en-US") */
  language?: string;
  /** Enable interim/partial results */
  interimResults?: boolean;
  /** Custom vocabulary/keywords to boost */
  keywords?: string[];
  /**
   * How long `flush()` may wait for a final transcription result before
   * giving up and returning (default: 1500ms). Keeps a stalled recognizer
   * from blocking the conversation loop.
   */
  flushTimeoutMs?: number;
}

export interface STTStream {
  /** Feed audio data into the recognizer */
  write(chunk: AudioChunk): void;
  /** Register handler for transcription results */
  onResult(handler: (result: STTResult) => void): void;
  /**
   * Register a handler for stream-level failures (auth, network, protocol).
   * Optional — streams that cannot fail recoverably may omit it.
   *
   * Note: this is deliberately *not* an `error` event, because emitting
   * `error` on an EventEmitter with no listener throws and takes the
   * process down.
   */
  onError?(handler: (error: Error) => void): void;
  /**
   * Resolve once the audio written so far has been transcribed and emitted
   * as a final result. Called by the pipeline when the user stops speaking
   * so the turn is not submitted on a partial transcript.
   *
   * Optional — streaming providers may omit it if finals already arrive
   * before the caller's grace period elapses.
   */
  flush?(): Promise<void>;
  /** Close the stream */
  close(): Promise<void>;
}

export interface STTResult {
  /** Transcribed text */
  text: string;
  /** Whether this is a final or interim result */
  isFinal: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Word-level timestamps (if available) */
  words?: Array<{ word: string; startMs: number; endMs: number }>;
}

// ─── TTS (Text-to-Speech) ──────────────────────────────────────────────────

/** Text-to-Speech provider interface */
export interface TTSProvider {
  /** Provider name (e.g., "elevenlabs", "edge-tts") */
  readonly name: string;
  /** Synthesize text to audio — returns a stream of audio chunks */
  synthesize(text: string, options?: TTSOptions): AsyncIterable<AudioChunk>;
}

export interface TTSOptions {
  /** Voice ID or name */
  voice?: string;
  /** Speaking speed multiplier (1.0 = normal) */
  speed?: number;
  /** Voice pitch adjustment */
  pitch?: number;
  /**
   * Cancellation signal, typically driven by barge-in.
   *
   * When the caller interrupts the agent mid-utterance, aborting this signal
   * lets the provider tear down its HTTP stream. Without it the vendor keeps
   * transmitting the rest of an utterance nobody will hear.
   */
  signal?: AbortSignal;
}

// ─── Turn Handling ─────────────────────────────────────────────────────────

/**
 * How the pipeline decides the user has finished speaking.
 *
 * - `vad`  — energy/speech-detection hangover only (default, zero-dependency)
 * - `stt`  — defer to the recognizer's own endpoint signal via `STTStream.flush()`
 * - `auto` — use `stt` when the provider implements `flush()`, else `vad`
 */
export type TurnDetectionMode = "vad" | "stt" | "auto";

export interface EndpointingOptions {
  /** Turn detection source. Default: `auto` */
  detection?: TurnDetectionMode;
  /**
   * Fixed mode: silence required after the last speech frame before the turn
   * closes. Default: 800ms.
   */
  minDelayMs?: number;
  /**
   * Hard cap on how long the pipeline will wait for a turn to close once the
   * user has clearly stopped. Default: 3000ms. Prevents a stuck VAD from
   * silently swallowing a turn.
   */
  maxDelayMs?: number;
  /**
   * `dynamic` adapts the silence window within [minDelayMs, maxDelayMs] from
   * observed pause statistics, so fast speakers are not cut off and slow
   * speakers are not left waiting. Default: `fixed`.
   */
  mode?: "fixed" | "dynamic";
}

/**
 * How the agent reacts when the user speaks over it.
 */
export interface InterruptionOptions {
  /** Master switch. Default: true */
  enabled?: boolean;
  /**
   * `immediate` stops playback on any detected speech.
   * `adaptive` requires the speech to look like a real interruption —
   * sustained for `minSpeechMs`, and (when `minWords > 0`) backed by at least
   * that many transcribed words — so "uh-huh", a cough or background noise no
   * longer silence the agent permanently.
   */
  mode?: "immediate" | "adaptive";
  /** Minimum sustained speech before it counts as an interruption. Default: 500ms */
  minSpeechMs?: number;
  /**
   * Minimum transcribed words before it counts as an interruption.
   * Requires an STT provider that emits interim results. Default: 0.
   */
  minWords?: number;
  /**
   * Silence window after a candidate interruption before it is classified as
   * false. If no transcript arrives within this, playback resumes from where it
   * stopped. Default: 2000ms.
   */
  falseInterruptionTimeoutMs?: number;
  /** Resume speaking when an interruption is classified as false. Default: true */
  resumeOnFalseInterruption?: boolean;
}

/**
 * Start deciding before the user's turn is fully confirmed.
 *
 * JEV routing begins as soon as a first final transcript arrives, overlapping
 * the remaining endpointing wait. The in-flight decision is cancelled and
 * redone if the transcript later changes, so a mutated utterance is never
 * answered from a stale guess.
 */
export interface PreemptiveOptions {
  /** Default: true */
  enabled?: boolean;
  /** Skip preemption for utterances longer than this. Default: 10000ms */
  maxSpeechMs?: number;
  /** Cap on preemption attempts per turn, to bound wasted work. Default: 3 */
  maxRetries?: number;
}

/** A keypad digit received from the caller. */
export interface DTMFEvent {
  /** The digit pressed: 0-9, *, #, A-D. */
  digit: string;
  /** Session the digit belongs to. */
  sessionId: string;
  /** Milliseconds since the session started. */
  timestampMs: number;
}

/** Keypad collection behaviour for one session. */
export interface DTMFConfig {
  /** Master switch. Default: true — digits are always surfaced. */
  enabled?: boolean;
  /**
   * Digits that complete an entry (4 for a PIN). When reached, the collected
   * digits are submitted as the turn's input so the agent responds to them.
   */
  expectedDigits?: number;
  /** Digit that explicitly ends an entry, e.g. "#". */
  terminateOn?: string;
  /** Discard a partial entry after this long without a digit (ms). Default: 10000 */
  idleTimeoutMs?: number;
}

/** Input audio conditioning applied before VAD/STT. */
export interface AudioOptions {
  /** Master switch. Default: true */
  enabled?: boolean;
  /** High-pass corner frequency in Hz. Default: 80 */
  highPassHz?: number;
  /** Noise gate strength, 0-1. 0 disables. Default: 0.06 */
  noiseGate?: number;
  /** Target RMS for automatic gain control, 0-1. 0 disables. Default: 0.06 */
  targetRms?: number;
  /** Maximum gain factor. Default: 8 */
  maxGain?: number;
}

// ─── VAD (Voice Activity Detection) ─────────────────────────────────────────

/** Voice Activity Detection interface */
export interface VADProvider {
  /** Provider name */
  readonly name: string;
  /** Process an audio chunk and detect speech */
  process(chunk: AudioChunk): VADResult;
  /** Reset internal state */
  reset(): void;
}

export interface VADResult {
  /** Whether speech is detected in this chunk */
  isSpeech: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Speech event (if a transition occurred) */
  event?: VADEvent;
}

export type VADEvent =
  | { type: "speech_start"; timestampMs: number }
  | { type: "speech_end"; timestampMs: number; durationMs: number };


// ─── Tools ──────────────────────────────────────────────────────────────────

/** A tool that the agent can call */
export interface AgentTool {
  /** Unique tool name */
  name: string;
  /** Description of what this tool does */
  description: string;
  /** JSON schema for the tool's parameters */
  parameters: Record<string, unknown>;
  /** Execute the tool */
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Tool executor interface */
export interface ToolExecutor {
  /** Call a registered tool by name */
  call(toolName: string, params?: Record<string, unknown>): Promise<unknown>;
  /** List all registered tools */
  list(): AgentTool[];
}

// ─── Memory ─────────────────────────────────────────────────────────────────

/** Conversation memory manager */
export interface MemoryManager {
  /** Add a turn to memory */
  addTurn(turn: ConversationTurn): void;
  /** Get all turns */
  getTurns(): ConversationTurn[];
  /** Get the last N turns */
  getRecentTurns(n: number): ConversationTurn[];
  /** Set a slot value */
  setSlot(key: string, value: unknown): void;
  /** Get a slot value */
  getSlot(key: string): unknown;
  /** Get all slots */
  getSlots(): Record<string, unknown>;
  /** Clear all memory */
  clear(): void;
  /** Build the full conversation context */
  buildContext(session: Session, systemPrompt: string): ConversationContext;
}

// ─── JEV Engine ─────────────────────────────────────────────────────────────

/** JEV (Joint Embedding Vector) engine interface */
export interface JEVEngine {
  /** Initialize the engine (load models, embed action space) */
  initialize(actions: AgentAction[]): Promise<void>;
  /** Full pipeline: encode context → predict → match to action */
  decide(context: ConversationContext): Promise<ActionMatch>;
  /** Encode conversation context into a vector */
  encode(context: ConversationContext): Promise<Float64Array>;
  /** Predict the next state vector from a context vector */
  predict(contextVector: Float64Array): Promise<Float64Array>;
  /** Match a vector to the closest action */
  match(vector: Float64Array): Promise<ActionMatch>;
}

/** Embedding provider for JEV */
export interface EmbeddingProvider {
  /** Provider name */
  readonly name: string;
  /** Embed a single text string */
  embed(text: string): Promise<Float64Array>;
  /** Embed multiple texts in a batch */
  embedBatch(texts: string[]): Promise<Float64Array[]>;
  /** Dimensionality of the embeddings */
  readonly dimensions: number;
}

// ─── Decision Providers ─────────────────────────────────────────────────────

/**
 * A bounded question posed about a state.
 *
 * The three shapes mirror the System One contract. `choice` picks one option
 * from a declared set, `noul` reports the probability that a proposition holds,
 * and `score` reports a position on ordered levels. None of them generate text,
 * so nothing has to be parsed back out of prose.
 */
export type DecisionQuestion =
  | {
      type: "choice";
      instructions: string;
      /** Option name → what that option means, or null when the name says enough. */
      criteria: Record<string, string | null>;
    }
  | {
      type: "noul";
      instructions: string;
      /** Optional descriptions of what yes and no each mean. */
      criteria?: { true?: string; false?: string };
    }
  | {
      type: "score";
      instructions: string;
      /** Level descriptions, ordered lowest to highest. */
      criteria: string[];
    };

/** One answer, keyed by the question id it belongs to. */
export interface DecisionAnswers {
  /** Present for a `choice` question. */
  choice?: string;
  /** Probability of "yes", 0–1. Present for a `noul` question. */
  noul?: number;
  /** Probability-weighted level index, 0-based. Present for a `score` question. */
  score?: number;
  /** Every option's probability for `choice`; every level's for `score`. */
  probabilities?: Record<string, number>;
  /** How concentrated the distribution is. Not a measure of correctness. */
  confidence?: number;
  /** Level index → description, for a `score` question. */
  legend?: Record<string, string>;
}

/** What one decision request cost, when the provider reports it. */
export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The result of a decision request. */
export interface DecisionResult {
  /** One answer per question id requested. */
  answers: Record<string, DecisionAnswers>;
  /** The model version that answered, when the provider reports one. */
  model?: string;
  usage?: DecisionUsage;
}

/** Options for a single {@link DecisionProvider.decide} call. */
export interface DecisionRequestOptions {
  /** Cancels the request, e.g. on barge-in. */
  signal?: AbortSignal;
  /** Deadline in ms. */
  timeoutMs?: number;
}

/**
 * A backend that answers bounded questions about a state.
 *
 * This is the routing step's other half. Where an embedding provider turns
 * text into a vector for cosine comparison, a decision provider reads declared
 * option probabilities directly off a model — no sampled answer token, and a
 * score that is an actual probability rather than a similarity.
 */
export interface DecisionProvider {
  /** Provider name, used in logs and errors. */
  readonly name: string;
  /** The model this provider pins, when it exposes one. */
  readonly model?: string;
  /**
   * Ask every question about one state, in a single call.
   *
   * All questions share the state but not each other's answers, so one request
   * is cheaper and faster than one request per question.
   */
  decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
    options?: DecisionRequestOptions,
  ): Promise<DecisionResult>;
}

/** Configuration for a decision-model routing backend. */
export interface DecisionProviderConfig {
  /**
   * Backend to talk to, or a provider instance.
   *
   * Built-in names: `"systemone"` (the System One wire protocol, served by the
   * hosted service and by compatible local servers). For anything else, pass an
   * instance implementing {@link DecisionProvider}.
   */
  provider: string | DecisionProvider;
  /** API key, where the endpoint requires one. */
  apiKey?: string;
  /** Base URL, overriding the backend's default. */
  baseUrl?: string;
  /** Model name to pin. Prefer a pinned version over a moving alias. */
  model?: string;
  /** Deadline in ms per decision. Default: 5000. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * What to do when the decision call fails.
   *
   * `"fallback"` (default) routes to the `fallback` action instead of failing
   * the turn. `"throw"` rejects, so a misconfigured deployment is loud.
   */
  onError?: "fallback" | "throw";
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/** Lifecycle hooks for the agent */
export interface AgentHooks {
  /** Called when a new session starts */
  onCallStart?: (session: Session) => Promise<void>;
  /** Called when JEV selects an action */
  onActionSelected?: (
    action: AgentAction,
    confidence: number,
    context: ConversationContext,
  ) => Promise<void>;
  /** Called after the agent speaks */
  onAgentSpoke?: (text: string, session: Session) => Promise<void>;
  /** Called after the user speaks */
  onUserSpoke?: (text: string, session: Session) => Promise<void>;
  /** Called when a session ends */
  onCallEnd?: (session: Session, turns: ConversationTurn[]) => Promise<void>;
  /** Called on any error */
  onError?: (error: Error, session?: Session) => Promise<void>;
  /** Called when the user interrupts (barge-in) */
  onBargeIn?: (session: Session) => Promise<void>;
}

// ─── Agent Config ───────────────────────────────────────────────────────────

/** Full configuration for a FelAgent */
export interface FelAgentConfig {
  /** Agent name */
  name: string;
  /** System prompt that defines the agent's personality */
  systemPrompt?: string;

  /** STT provider configuration or direct STTProvider instance */
  stt?:
    | {
        provider: string;
        apiKey?: string;
        language?: string;
        [key: string]: unknown;
      }
    | STTProvider;

  /** TTS provider configuration or direct TTSProvider instance */
  tts?:
    | {
        provider: string;
        apiKey?: string;
        voice?: string;
        [key: string]: unknown;
      }
    | TTSProvider;


  /** JEV engine configuration */
  jev?: {
    /**
     * Embedding model/provider to use.
     *
     * Either an `EmbeddingProvider` instance, or one of the built-in names:
     * `"fast-semantic"` (default, no API key required) or `"openai"`.
     */
    embeddingProvider?: string | EmbeddingProvider;
    /** API key for the `"openai"` embedding provider */
    embeddingApiKey?: string;
    /**
     * Route turns through a decision model instead of embedding similarity.
     *
     * Omit it and routing stays local: the action descriptions are embedded once
     * and each turn is matched by cosine similarity. Configure it and the same
     * action space is sent as one choice question per turn, answered with a
     * probability per action.
     */
    decision?: DecisionProviderConfig;
    /**
     * Path to a trained predictor model.
     *
     * Not supported in this release — configuring it makes `listen()` throw
     * rather than silently degrading to cold-start routing.
     */
    predictorModel?: string;
    /** Minimum confidence threshold — below this, route to the `fallback` action */
    confidenceThreshold?: number;
  };

  /** Voice activity detection tuning (per-session VAD instances) */
  vad?: {
    /** RMS threshold to start detecting speech (0-1). Default: 0.01 */
    speechThreshold?: number;
    /** RMS threshold to stop detecting speech (0-1). Default: 0.005 */
    silenceThreshold?: number;
    /** Silence duration before a turn is considered finished (ms). Default: 800 */
    hangoverMs?: number;
    /** Minimum speech duration for a valid turn (ms). Default: 100 */
    minSpeechMs?: number;
  };

  /** Turn detection and endpointing */
  endpointing?: EndpointingOptions;

  /** Barge-in / interruption behaviour */
  interruption?: InterruptionOptions;

  /** Begin routing before the user's turn is fully confirmed */
  preemptive?: PreemptiveOptions;

  /** Input audio conditioning (high-pass, noise gate, AGC) */
  audio?: AudioOptions;

  /** Keypad (DTMF) input handling */
  dtmf?: DTMFConfig;

  /**
   * Retrieval over the agent's own documentation.
   *
   * Retrieval only: passages are returned to the handler, which decides the
   * wording. Reuses the JEV embedding provider, so this costs no extra provider.
   */
  knowledge?: {
    /** Retrieval options. */
    topK?: number;
    /** Similarity floor; below it the agent is told it does not know. Default: 0.2 */
    minScore?: number;
    /** Chunking strategy. */
    chunk?: {
      targetChars?: number;
      minChars?: number;
      maxChars?: number;
      overlapChars?: number;
    };
  };

  /**
   * Call transfer credentials. Without these, `ctx.transfer()` is unavailable
   * and the agent reports that it cannot escalate rather than pretending to.
   */
  transfers?: {
    /** Twilio Account SID. */
    accountSid: string;
    /** Twilio Auth Token. */
    authToken: string;
    /** Override the Twilio API base URL. */
    baseUrl?: string;
  };

  /**
   * Speech language.
   *
   * Either a single BCP-47 tag (`"en-US"`, `"es-ES"`) or a list to accept
   * several, in which case the recognizer auto-detects among them. This was
   * previously hardcoded to `"en-US"` in the pipeline, so a non-English agent
   * silently transcribed against the wrong model.
   */
  language?: string | string[];

  /**
   * How long to wait for a final transcript before submitting a turn (ms).
   * Raise this for slow/batch STT providers. Default: 1500.
   */
  sttFlushTimeoutMs?: number;

  /** Actions the agent can take */
  actions: AgentAction[];

  /** Tools the agent can call */
  tools?: AgentTool[];

  /**
   * OpenTelemetry instrumentation for calls and tool calls.
   *
   * Omit to use the global OpenTelemetry tracer, which does nothing until the
   * application registers a tracer provider. Inject one to control the
   * instrumentation scope or to assert on spans in a test.
   */
  tracer?: FelonaTracer;

  /**
   * How to judge the call when it ends — which actions count as a successful
   * ending, which count as an escalation, and a hook that reports the real
   * outcome when your systems know it.
   *
   * Omit it and post-call analysis infers everything from the transcript.
   */
  analysis?: AnalyzeOptions;

  /** Lifecycle hooks */
  hooks?: AgentHooks;

  /**
   * Whether lifecycle hooks are awaited before the turn continues.
   *
   * - `await` (default) — each hook completes before the pipeline moves on.
   *   Correct when a hook writes state the next stage reads, e.g.
   *   `onUserSpoke` capturing a caller id that a handler then looks up.
   * - `detach` — hooks run in the background. No hook returns a value the
   *   pipeline uses, so awaiting one only adds its latency to the caller's
   *   wait. Use this when hooks are pure observers: analytics, scoring, CRM
   *   writes, logging.
   */
  hooksMode?: "await" | "detach";

  /**
   * Answering-machine detection.
   *
   * Omit to disable. On an outbound campaign a voicemail greeting is otherwise
   * transcribed and routed as if a person had spoken, which burns a
   * concurrency slot and inflates the reported answer rate.
   */
  voicemail?: VoicemailOptions;

  /**
   * Let handlers replace the system prompt mid-call.
   *
   * Off by default. A handler that can rewrite its own instructions can also
   * be talked into doing so by a caller, so this is a deliberate opt-in rather
   * than a default.
   */
  allowPromptOverride?: boolean;

  /**
   * Checks on caller speech (before routing) and on the agent's reply (before
   * speaking).
   *
   * Both boundaries are open by default: caller text reaches JEV routing, the
   * knowledge base and tool arguments uninspected, and a handler's return value
   * is spoken verbatim. Nothing is blocked unless a guardrail is configured.
   */
  guardrails?: GuardrailOptions;

  /**
   * Per-call cost accounting.
   *
   * Omit to skip tracking. Prices are yours to supply — a framework default
   * would go stale and silently misreport spend.
   */
  cost?: {
    /** Published USD prices. Omitted components are not counted. */
    prices?: PriceTable;
    /**
     * Called as a call's tally changes, and once more with the final figure
     * when it ends. This is the hook to forward per-call cost to a billing
     * system.
     */
    onCallCost?: (sessionId: string, cost: CallCost) => void;
  };

  /** Transport config or custom Transport instance */
  transport?:
    | {
        type?: "websocket" | "twilio" | "webrtc";
        port?: number;
        host?: string;
        path?: string;
        streamUrl?: string;
        greeting?: string;
        /** Shared secret required from WebSocket clients */
        authToken?: string;
        /** Custom WebSocket upgrade check */
        verifyClient?: (req: import("http").IncomingMessage) => boolean;
        /** Heartbeat ping interval in ms (0 disables). Default: 30000 */
        heartbeatIntervalMs?: number;
        /** Max simultaneous connections */
        maxConnections?: number;
        /** Twilio auth token, for X-Twilio-Signature validation */
        authTokenTwilio?: string;
        /** Public base URL of this server, required for signature validation */
        publicUrl?: string;
        /** Restrict the TwiML webhook to these Host values */
        allowedHosts?: string[];
        [key: string]: unknown;
      }
    | Transport;

  /** Session management and horizontal scaling configuration */
  sessions?: SessionManagerOptions;

  /**
   * Hard ceiling on how long a single call may run, in ms. Default: 1800000
   * (30 minutes). `0` disables the limit.
   *
   * A call with no ceiling holds a pipeline, VAD, preprocessor, STT socket and
   * conversation memory for as long as the far end stays connected — including
   * a half-open socket that never sends a close. This is the backstop for
   * those, not a substitute for transport-level timeouts.
   */
  maxCallDurationMs?: number;

  /**
   * How often to sweep for calls that have outlived `maxCallDurationMs` or
   * whose transport has gone away. Default: 30000ms. `0` disables the sweep.
   */
  callSweepIntervalMs?: number;

  /** Logging configuration */
  logging?: {
    /** Enable call logging for JEV training */
    enabled?: boolean;
    /** Directory to write logs */
    logDir?: string;
    /** Log level */
    level?: "debug" | "info" | "warn" | "error";
    /**
     * Log output shape. Default: `text`.
     *
     * `json` emits one JSON object per line for a log shipper to index; `text`
     * stays readable in a terminal. Choose based on where the logs go.
     */
    format?: "text" | "json";
  };
}

/** Options for direct agent interaction (simulate turn without WebSocket) */
export interface InteractOptions {
  /** The user's input text message */
  userMessage: string;
  /** Optional session identifier (defaults to a persistent single session) */
  sessionId?: string;
  /** Initial or updated slot values */
  slots?: Record<string, unknown>;
  /** Prior conversation history */
  history?: Array<{ role: "user" | "agent"; content: string; actionId?: string }>;
}

/** Result of an agent interaction turn */
export interface InteractResult {
  /** The response text spoken by the agent */
  text: string;
  /** The action matched and executed by JEV */
  action: AgentAction;
  /** JEV confidence score (0 to 1) */
  confidence: number;
  /** All action candidates with their similarity scores */
  candidates: Array<{ actionId: string; score: number }>;
  /** Current slot values */
  slots: Record<string, unknown>;
  /** Telemetry information */
  telemetry: {
    latencyMs: number;
    actionSpaceSize: number;
    embeddingModel: string;
  };
}

