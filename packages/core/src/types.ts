/**
 * Core type definitions for Felona Voice.
 *
 * These types define the contracts between all modules in the framework.
 * Every provider, engine, and component implements interfaces defined here.
 */

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

/** Context passed to action handlers */
export interface ActionContext {
  /** The full conversation context */
  conversation: ConversationContext;
  /** LLM interface for generating responses */
  llm: LLMInterface;
  /** Tool executor for calling external tools */
  tools: ToolExecutor;
  /** Conversation memory manager */
  memory: MemoryManager;
  /** The current session */
  session: Session;
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
  /** Register handler for incoming audio */
  onAudioChunk(handler: (sessionId: string, chunk: AudioChunk) => void): void;
  /** Register handler for new connections */
  onConnect(handler: (session: Session) => void): void;
  /** Register handler for disconnections */
  onDisconnect(handler: (session: Session) => void): void;
  /** Send audio to a specific session */
  sendAudio(sessionId: string, chunk: AudioChunk): Promise<void>;
}

export interface TransportOptions {
  port: number;
  host?: string;
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
}

export interface STTStream {
  /** Feed audio data into the recognizer */
  write(chunk: AudioChunk): void;
  /** Register handler for transcription results */
  onResult(handler: (result: STTResult) => void): void;
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

// ─── LLM ────────────────────────────────────────────────────────────────────

/** LLM provider interface */
export interface LLMProvider {
  /** Provider name (e.g., "openai", "anthropic") */
  readonly name: string;
  /** Create an LLM interface with specific config */
  create(options: LLMOptions): LLMInterface;
}

export interface LLMOptions {
  /** Model name (e.g., "gpt-4o-mini") */
  model: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
}

/** LLM interface used by action handlers */
export interface LLMInterface {
  /** Generate a response given a prompt and conversation context */
  generate(prompt: string, context?: LLMContext): Promise<string>;
  /** Generate a streaming response */
  generateStream(
    prompt: string,
    context?: LLMContext,
  ): AsyncIterable<string>;
}

export interface LLMContext {
  /** System prompt */
  systemPrompt?: string;
  /** Conversation history */
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Additional instructions */
  instructions?: string;
}

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
  systemPrompt: string;

  /** STT provider configuration */
  stt: {
    provider: string;
    apiKey?: string;
    language?: string;
    [key: string]: unknown;
  };

  /** TTS provider configuration */
  tts: {
    provider: string;
    apiKey?: string;
    voice?: string;
    [key: string]: unknown;
  };

  /** LLM provider configuration */
  llm: {
    provider: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    [key: string]: unknown;
  };

  /** JEV engine configuration */
  jev?: {
    /** Embedding model/provider to use */
    embeddingProvider?: string;
    embeddingApiKey?: string;
    /** Path to a trained predictor model (ONNX) */
    predictorModel?: string;
    /** Minimum confidence threshold — below this, fall back to LLM-only */
    confidenceThreshold?: number;
  };

  /** Actions the agent can take */
  actions: AgentAction[];

  /** Tools the agent can call */
  tools?: AgentTool[];

  /** Lifecycle hooks */
  hooks?: AgentHooks;

  /** Transport config */
  transport?: {
    type?: "websocket" | "webrtc";
    port?: number;
    host?: string;
  };

  /** Logging configuration */
  logging?: {
    /** Enable call logging for JEV training */
    enabled?: boolean;
    /** Directory to write logs */
    logDir?: string;
    /** Log level */
    level?: "debug" | "info" | "warn" | "error";
  };
}
