/**
 * Felona Voice — Open-source voice agent framework powered by JEV.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { FelAgent, defineAction } from "felona-voice";
 *
 * const agent = new FelAgent({
 *   name: "My Agent",
 *   systemPrompt: "You are helpful.",
 *   stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
 *   stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
 *   tts: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY, voice: "aura-asteria-en" },
 *   actions: [
 *     defineAction({
 *       id: "greet",
 *       description: "Greet the user warmly",
 *       handler: async () => "Hello! How can I assist you today?",
 *     }),
 *   ],
 * });
 *
 * agent.listen({ port: 8080 });
 * ```
 */

// ─── Main Entry Points ─────────────────────────────────────────────────────
export { FelAgent, defineAction, quickStart } from "./agent.js";
export {
  createAgent,
  createSupportAgent,
  createSalesAgent,
  AgentBuilder,
} from "./builder.js";
export type { ActionHandlerFn } from "./builder.js";

// ─── LangGraph-Style Voice Graph & Visualization ───────────────────────────
export {
  VoiceGraph,
  CompiledVoiceGraph,
  START,
  END,
} from "./graph/voice-graph.js";
export {
  visualizeGraph,
  drawAscii,
  drawMermaid,
  drawMarkdown,
  generateGraphMarkdown,
  toMermaidLiveUrl,
  generateGraphHtml,
  extractGraphData,
} from "./graph/visualize.js";
export type {
  NodeOptions,
  NodeRunFn,
  NodeRunResult,
  GraphRunContext,
  GraphInvokeInput,
  GraphInvokeOutput,
  GraphData,
  VisualizeOptions,
  VisualizeResult,
} from "./graph/voice-graph.js";

// ─── JEV Engine ─────────────────────────────────────────────────────────────
export { JEVEngine, createJEVEngine } from "./jev/engine.js";
export { ActionSpace, cosineSimilarity } from "./jev/action-space.js";
export { OpenAIEmbeddingProvider } from "./jev/embeddings.js";
export { FastSemanticEmbeddingProvider } from "./jev/fast-embeddings.js";

// ─── Voice Pipeline ─────────────────────────────────────────────────────────
export { VoicePipeline, createPipeline } from "./pipeline.js";

// ─── Transport ──────────────────────────────────────────────────────────────
export {
  WebSocketTransport,
  createWebSocketTransport,
} from "./transport/websocket.js";

// ─── STT Providers ──────────────────────────────────────────────────────────
export { DeepgramSTT, createDeepgramSTT } from "./stt/deepgram.js";
export { WhisperSTT, createWhisperSTT, type WhisperSTTOptions } from "./stt/whisper.js";
export { AssemblyAISTT, createAssemblyAISTT, type AssemblyAISTTOptions } from "./stt/assemblyai.js";
export { AzureSTT, createAzureSTT, type AzureSTTOptions } from "./stt/azure.js";
export { GoogleSTT, createGoogleSTT, type GoogleSTTOptions } from "./stt/google.js";
export { pcmToWav } from "./stt/wav.js";

// ─── TTS Providers ──────────────────────────────────────────────────────────
export { ElevenLabsTTS, createElevenLabsTTS } from "./tts/eleven-labs.js";
export { DeepgramTTS, createDeepgramTTS } from "./tts/deepgram.js";
export { OpenAITTS, createOpenAITTS, type OpenAITTSOptions, type OpenAIVoice } from "./tts/openai.js";
export { CartesiaTTS, createCartesiaTTS, type CartesiaTTSOptions } from "./tts/cartesia.js";
export { AzureTTS, createAzureTTS, type AzureTTSOptions } from "./tts/azure.js";
export { PollyTTS, createPollyTTS, type PollyTTSOptions } from "./tts/polly.js";
export { LMNTTTS, createLMNTTTS, type LMNTTTSOptions } from "./tts/lmnt.js";

// ─── VAD Providers ──────────────────────────────────────────────────────────
export { EnergyVAD, createEnergyVAD } from "./vad/energy.js";


// ─── Memory ─────────────────────────────────────────────────────────────────
export { ConversationMemory, createMemory } from "./memory/context.js";

// ─── Tools ──────────────────────────────────────────────────────────────────
export { ToolRegistry, defineTool, createToolRegistry } from "./tools/registry.js";

// ─── Analytics ──────────────────────────────────────────────────────────────
export { CallLogger, createCallLogger } from "./analytics/logger.js";
export type {
  CallLogEntry,
  JEVDecisionLog,
  CallMetrics,
  CallLogFile,
} from "./analytics/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  // Audio
  AudioChunk,
  // Session
  Session,
  SessionState,
  // Conversation
  ConversationTurn,
  ConversationContext,
  // Actions
  AgentAction,
  ActionContext,
  ActionMatch,
  // Transport
  Transport,
  TransportOptions,
  // STT
  STTProvider,
  STTStream,
  STTStreamOptions,
  STTResult,
  // TTS
  TTSProvider,
  TTSOptions,
  // VAD
  VADProvider,
  VADResult,
  VADEvent,
  // Tools
  AgentTool,
  ToolExecutor,
  // Memory
  MemoryManager,
  // JEV
  JEVEngine as JEVEngineInterface,
  EmbeddingProvider,
  // Hooks
  AgentHooks,
  // Config & Interactions
  FelAgentConfig,
  InteractOptions,
  InteractResult,
} from "./types.js";
