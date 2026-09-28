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

// ─── Voice Graph & State Machine Visualization ─────────────────────────
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
  type WebSocketTransportOptions,
} from "./transport/websocket.js";
export {
  WebRTCTransport,
  createWebRTCTransport,
  type WebRTCTransportOptions,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type MediaTrackLike,
} from "./transport/webrtc.js";
export {
  PcmuPacketizer,
  serializeRtpAudioPacket,
  parseRtpAudioPacket,
  randomSsrc,
  PCMU_PAYLOAD_TYPE,
  PCMU_CLOCK_RATE,
  SAMPLES_PER_FRAME,
  type RtpAudioPacket,
} from "./transport/rtp.js";

// ─── Telephony & Mobile Providers (Twilio, Telnyx) ──────────────────────────
export {
  TwilioTransport,
  createTwilioTransport,
  createTwilioStreamTwiML,
  createTelnyxStreamTeXML,
  makeTwilioCall,
  mulawToPcm16,
  pcm16ToMulaw,
  alawToPcm16,
  pcm16ToAlaw,
  resamplePcm16,
  mulaw8kToPcm16k,
  alaw8kToPcm16k,
  pcm16ToMulaw8k,
  pcm16ToAlaw8k,
  linearSampleToMulaw,
  linearSampleToAlaw,
  decodeTelephonyAudio,
  encodeTelephonyAudio,
  buildTransferTwiml,
  TwilioTransferProvider,
  createTwilioTransferProvider,
  PIPELINE_SAMPLE_RATE,
} from "./telephony/index.js";
export type {
  TwilioTransportOptions,
  TwilioStreamTwiMLOptions,
  TwilioOutboundCallOptions,
  TwilioCallResult,
  TwilioTransferOptions,
  G711Encoding,
  TransferMode,
  TransferRequest,
  TransferResult,
  CallTransferProvider,
} from "./telephony/index.js";

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

// ─── Audio Processing ───────────────────────────────────────────────────────
export {
  AudioPreprocessor,
  createAudioPreprocessor,
  type AudioPreprocessorOptions,
} from "./audio/preprocess.js";
export {
  DTMFCollector,
  createDTMFCollector,
  type DTMFOptions,
  type DTMFEntry,
} from "./audio/dtmf.js";


// ─── Supervision (listen in, coach, take over) ─────────────────────────────
export {
  CallSupervisor,
  createCallSupervisor,
  type SupervisorHandle,
  type SupervisionState,
  type SupervisionEvent,
  type TakeoverOptions,
} from "./supervision/controller.js";

// ─── Knowledge Base ────────────────────────────────────────────────────────
export {
  KnowledgeBase,
  createKnowledgeBase,
  type KnowledgeBaseOptions,
  type KnowledgeDocument,
  type KnowledgeChunk,
  type KnowledgeSearchOptions,
  type KnowledgeSearcher,
} from "./knowledge/kb.js";
export {
  chunkText,
  chunkDocument,
  splitSentences,
  type ChunkOptions,
} from "./knowledge/chunk.js";
export {
  createKnowledgeTask,
  defaultKnowledgeAnswer,
  type KnowledgeTaskOptions,
} from "./knowledge/task.js";

// ─── Language / i18n ────────────────────────────────────────────────────────
export {
  LANGUAGES,
  getLanguage,
  describeLanguage,
  detectLanguage,
  normalizeLanguage,
  type LanguageDefinition,
} from "./i18n/language.js";

// ─── Slot Extraction & Prebuilt Tasks ────────────────────────────────────────
export {
  SlotCollector,
  createSlotCollector,
  type SlotDefinition,
  type SlotRecord,
  type IngestResult,
} from "./slots/collector.js";
export {
  createCollectTask,
  continueCollectTask,
  getTaskCollector,
  resetTaskCollector,
  getNameTask,
  getEmailTask,
  getPhoneNumberTask,
  getAddressTask,
  getDateOfBirthTask,
  getZipCodeTask,
  getCreditCardTask,
  type CollectTaskOptions,
} from "./slots/tasks.js";
export {
  EXTRACTORS,
  VALIDATORS,
  DEFAULT_PROMPTS,
  extractEmail,
  extractPhone,
  extractCardNumber,
  extractExpiry,
  extractCvv,
  extractZip,
  extractName,
  extractAddress,
  extractNumber,
  extractDate,
  extractString,
  validateEmail,
  validatePhone,
  validateCardNumber,
  validateExpiry,
  validateCvv,
  validateZip,
  validateName,
  validateAddress,
  validateNumber,
  validateDate,
  luhnValid,
  stripCorrection,
  type SlotType,
  type ExtractionResult,
  type ValidationResult,
} from "./slots/extractors.js";
export {
  spokenDigitsToLiteral,
  spokenSymbolsToLiteral,
  normalizeSpoken,
  extractDigits,
  stripFillers,
  tokenize,
} from "./slots/spoken.js";

// ─── Scenario Testing ───────────────────────────────────────────────────────
export {
  runScenario,
  runScenarios,
  formatScenarioReport,
  type Scenario,
  type ScenarioTurn,
  type ScenarioResult,
  type ScenarioReport,
  type TurnExpectations,
  type TurnResult,
  type RunScenariosOptions,
} from "./testing/scenarios.js";

// ─── Memory ─────────────────────────────────────────────────────────────────
export { ConversationMemory, createMemory } from "./memory/context.js";

// ─── Tools ──────────────────────────────────────────────────────────────────
export { ToolRegistry, defineTool, createToolRegistry } from "./tools/registry.js";
export {
  McpClient,
  StdioMcpTransport,
  createMcpClient,
  createStdioMcpTransport,
  collectMcpTools,
  extractMcpText,
  MCP_PROTOCOL_VERSION,
  type McpClientOptions,
  type McpServerOptions,
  type McpStdioTransportOptions,
  type McpToolDescriptor,
  type McpToolResult,
  type McpTransport,
} from "./tools/mcp.js";

// ─── Analytics ──────────────────────────────────────────────────────────────
export { CallLogger, createCallLogger } from "./analytics/logger.js";
export {
  analyzeCall,
  analyzeSentiment,
  analyzeConfidence,
  type CallAnalysis,
  type SentimentScore,
  type ConfidenceProfile,
  type AnalyzeOptions,
  type Sentiment,
} from "./analytics/call-analysis.js";
export type {
  CallLogEntry,
  JEVDecisionLog,
  CallMetrics,
  CallLogFile,
} from "./analytics/logger.js";

// ─── Observability ──────────────────────────────────────────────────────────
export {
  FelonaTracer,
  createFelonaTracer,
  contentFingerprint,
  formatTraceContext,
  SPAN,
  TRACER_NAME,
  TRACER_VERSION,
  type FelonaTracerOptions,
  type SpanName,
} from "./observability/tracing.js";

// ─── Cost ──────────────────────────────────────────────────────────────────
export {
  CostTracker,
  createCostTracker,
  emptyCallCost,
  type CallCost,
  type PriceTable,
} from "./observability/cost.js";

// ─── Metrics ───────────────────────────────────────────────────────────────
export {
  MetricsRegistry,
  defaultMetrics,
  registerCallMetrics,
  type MetricSample,
} from "./observability/metrics.js";

// ─── Voicemail ──────────────────────────────────────────────────────────────
export {
  VoicemailDetector,
  createVoicemailDetector,
  looksLikeHuman,
  matchesMachinePhrase,
  type VoicemailOptions,
  type VoicemailVerdict,
} from "./voicemail/index.js";

// ─── LLM ────────────────────────────────────────────────────────────────────
export {
  AnthropicLLM,
  createAnthropicLLM,
  type AnthropicLLMOptions,
} from "./llm/index.js";

export {
  OpenAILLM,
  createOpenAILLM,
  turnsToMessages,
  type LLMChatOptions,
  type LLMMessage,
  type LLMProvider,
  type LLMResult,
  type LLMStreamEvent,
  type LLMToolCall,
  type LLMUsage,
  type OpenAILLMOptions,
} from "./llm/index.js";

// ─── Guardrails ─────────────────────────────────────────────────────────────
export {
  blockPattern,
  defaultInputBlockedText,
  defaultOutputBlockedText,
  maxLength,
  requireUnless,
  runGuardrails,
  type Guardrail,
  type GuardrailInput,
  type GuardrailOptions,
  type GuardrailResult,
  type GuardrailVerdict,
} from "./guardrails/index.js";

// ─── Resilience ─────────────────────────────────────────────────────────────
export {
  DEFAULT_FETCH_TIMEOUT_MS,
  TimeoutError,
  fetchWithTimeout,
  isAbortError,
  isRetryableError,
  isRetryableStatus,
  markRetryable,
  retry,
  type CancellableResponse,
  type FetchTimeoutOptions,
  type RetryOptions,
} from "./resilience/index.js";

// ─── Sessions & Scaling ─────────────────────────────────────────────────────
export {
  SessionManager,
  createSessionManager,
  MemorySessionStore,
  createMemorySessionStore,
} from "./session/index.js";
export type {
  SessionRecord,
  SessionStore,
  SessionManagerOptions,
  SessionStats,
} from "./types.js";

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
  // Turn handling
  TurnDetectionMode,
  EndpointingOptions,
  InterruptionOptions,
  PreemptiveOptions,
  AudioOptions,
  DTMFConfig,
  DTMFEvent,
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
