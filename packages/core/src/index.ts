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
 *   tts: { provider: "elevenlabs", apiKey: process.env.ELEVEN_API_KEY },
 *   llm: { provider: "openai", apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" },
 *   actions: [
 *     defineAction({
 *       id: "greet",
 *       description: "Greet the user warmly",
 *       handler: async (ctx) => ctx.llm.generate("Greet the user", {
 *         systemPrompt: ctx.conversation.systemPrompt,
 *       }),
 *     }),
 *   ],
 * });
 *
 * agent.listen({ port: 8080 });
 * ```
 */

// ─── Main Entry Points ─────────────────────────────────────────────────────
export { FelAgent, defineAction, quickStart } from "./agent.js";

// ─── JEV Engine ─────────────────────────────────────────────────────────────
export { JEVEngine, createJEVEngine } from "./jev/engine.js";
export { ActionSpace, cosineSimilarity } from "./jev/action-space.js";
export { OpenAIEmbeddingProvider } from "./jev/embeddings.js";

// ─── Voice Pipeline ─────────────────────────────────────────────────────────
export { VoicePipeline, createPipeline } from "./pipeline.js";

// ─── Transport ──────────────────────────────────────────────────────────────
export {
  WebSocketTransport,
  createWebSocketTransport,
} from "./transport/websocket.js";

// ─── STT Providers ──────────────────────────────────────────────────────────
export { DeepgramSTT, createDeepgramSTT } from "./stt/deepgram.js";

// ─── TTS Providers ──────────────────────────────────────────────────────────
export { ElevenLabsTTS, createElevenLabsTTS } from "./tts/eleven-labs.js";

// ─── VAD Providers ──────────────────────────────────────────────────────────
export { EnergyVAD, createEnergyVAD } from "./vad/energy.js";

// ─── LLM Providers ─────────────────────────────────────────────────────────
export { OpenAILLM, createOpenAILLM } from "./llm/openai.js";

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
  // LLM
  LLMProvider,
  LLMInterface,
  LLMOptions,
  LLMContext,
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
  // Config
  FelAgentConfig,
} from "./types.js";
