import { EventEmitter } from "node:events";
import type {
  AudioChunk,
  Session,
  STTProvider,
  STTStream,
  TTSProvider,
  VADProvider,
  LLMInterface,
  ConversationContext,
  ActionMatch,
  AgentHooks,
} from "./types.js";
import type { JEVEngine } from "./jev/engine.js";
import type { ConversationMemory } from "./memory/context.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { CallLogger, JEVDecisionLog } from "./analytics/logger.js";

/**
 * VoicePipeline — Orchestrates the full voice conversation loop.
 *
 * Audio In → VAD → STT → JEV Decision → LLM Generate → TTS → Audio Out
 *
 * One pipeline instance is created per active session (call).
 * It manages:
 * - Audio buffering and VAD-based turn detection
 * - Streaming STT transcription
 * - JEV-powered action selection
 * - LLM response generation
 * - Streaming TTS playback
 * - Barge-in (user interruption) handling
 */
export class VoicePipeline extends EventEmitter {
  private readonly sessionId: string;
  private readonly session: Session;
  private readonly stt: STTProvider;
  private readonly tts: TTSProvider;
  private readonly vad: VADProvider;
  private readonly llm: LLMInterface;
  private readonly jev: JEVEngine;
  private readonly memory: ConversationMemory;
  private readonly tools: ToolRegistry;
  private readonly logger: CallLogger;
  private readonly hooks: AgentHooks;
  private readonly systemPrompt: string;

  private sttStream: STTStream | null = null;
  private isSpeaking = false; // Is the agent currently speaking?
  private isProcessing = false; // Is the pipeline processing a user turn?
  private currentTranscript = "";
  private decisions: JEVDecisionLog[] = [];

  // Callback to send audio back to the client
  private sendAudioFn: ((chunk: AudioChunk) => Promise<void>) | null = null;

  constructor(options: {
    sessionId: string;
    session: Session;
    stt: STTProvider;
    tts: TTSProvider;
    vad: VADProvider;
    llm: LLMInterface;
    jev: JEVEngine;
    memory: ConversationMemory;
    tools: ToolRegistry;
    logger: CallLogger;
    hooks: AgentHooks;
    systemPrompt: string;
    sendAudio: (chunk: AudioChunk) => Promise<void>;
  }) {
    super();
    this.sessionId = options.sessionId;
    this.session = options.session;
    this.stt = options.stt;
    this.tts = options.tts;
    this.vad = options.vad;
    this.llm = options.llm;
    this.jev = options.jev;
    this.memory = options.memory;
    this.tools = options.tools;
    this.logger = options.logger;
    this.hooks = options.hooks;
    this.systemPrompt = options.systemPrompt;
    this.sendAudioFn = options.sendAudio;
  }

  /**
   * Start the pipeline — initialize STT stream and begin processing.
   */
  async start(): Promise<void> {
    this.logger.log("info", `Pipeline started for session ${this.sessionId}`);

    // Create STT stream
    this.sttStream = this.stt.createStream({
      interimResults: true,
      language: "en-US",
    });

    // Handle STT results
    this.sttStream.onResult((result) => {
      this.handleSTTResult(result);
    });

    // Notify hooks
    await this.hooks.onCallStart?.(this.session);

    this.emit("started");
  }

  /**
   * Process incoming audio from the transport.
   * This is called for every audio chunk received from the client.
   */
  processAudio(chunk: AudioChunk): void {
    // Step 1: VAD — detect if the user is speaking
    const vadResult = this.vad.process(chunk);

    // Step 2: Handle barge-in — user starts speaking while agent is talking
    if (vadResult.event?.type === "speech_start" && this.isSpeaking) {
      this.handleBargeIn();
    }

    // Step 3: Feed audio to STT (only when speech is detected)
    if (vadResult.isSpeech && this.sttStream) {
      this.sttStream.write(chunk);
    }

    // Step 4: Handle speech end — user stopped speaking, process the turn
    if (vadResult.event?.type === "speech_end" && !this.isProcessing) {
      this.handleUserTurnComplete();
    }
  }

  /**
   * Stop the pipeline — clean up resources.
   */
  async stop(): Promise<void> {
    // Log the call
    await this.logger.logCall({
      session: this.session,
      turns: this.memory.getTurns(),
      decisions: this.decisions,
      metrics: {
        totalTurns: this.memory.length,
        avgJEVLatencyMs: this.decisions.length > 0
          ? this.decisions.reduce((sum, d) => sum + d.latencyMs, 0) / this.decisions.length
          : 0,
        bargeInCount: 0, // TODO: track this
        avgConfidence: this.decisions.length > 0
          ? this.decisions.reduce((sum, d) => sum + d.confidence, 0) / this.decisions.length
          : 0,
      },
    });

    // Close STT stream
    await this.sttStream?.close();

    // Notify hooks
    await this.hooks.onCallEnd?.(this.session, this.memory.getTurns());

    this.logger.log("info", `Pipeline stopped for session ${this.sessionId}`);
    this.emit("stopped");
  }

  /**
   * Handle a STT transcription result.
   */
  private handleSTTResult(result: {
    text: string;
    isFinal: boolean;
    confidence: number;
  }): void {
    if (result.isFinal) {
      // Accumulate final transcripts
      this.currentTranscript += (this.currentTranscript ? " " : "") + result.text;
      this.emit("transcript", {
        text: this.currentTranscript,
        isFinal: true,
      });
    } else {
      // Emit interim for real-time feedback
      this.emit("transcript", {
        text: result.text,
        isFinal: false,
      });
    }
  }

  /**
   * Handle user turn completion — the user has stopped speaking.
   * This triggers the JEV → LLM → TTS pipeline.
   */
  private async handleUserTurnComplete(): Promise<void> {
    const userText = this.currentTranscript.trim();
    if (!userText) return; // Ignore empty turns

    this.isProcessing = true;
    this.currentTranscript = "";

    try {
      // Add user turn to memory
      this.memory.addTurn({
        role: "user",
        content: userText,
        timestampMs: Date.now() - this.session.startedAt.getTime(),
      });

      // Notify hooks
      await this.hooks.onUserSpoke?.(userText, this.session);

      // Build conversation context for JEV
      const context = this.memory.buildContext(
        this.session,
        this.systemPrompt,
        userText,
      );

      // JEV Decision — what should the agent do?
      const startTime = performance.now();
      const match = await this.jev.decide(context);
      const jevLatencyMs = performance.now() - startTime;

      // Log the decision
      const decisionLog: JEVDecisionLog = {
        timestampMs: Date.now() - this.session.startedAt.getTime(),
        contextSummary: userText.slice(0, 200),
        selectedAction: match.action.id,
        confidence: match.confidence,
        candidates: match.candidates.slice(0, 5),
        latencyMs: jevLatencyMs,
      };
      this.decisions.push(decisionLog);
      this.logger.logDecision(decisionLog);

      // Notify hooks
      await this.hooks.onActionSelected?.(match.action, match.confidence, context);

      this.logger.log(
        "info",
        `JEV selected: "${match.action.id}" (confidence: ${match.confidence.toFixed(3)}, latency: ${jevLatencyMs.toFixed(1)}ms)`,
      );

      // Execute the action handler — this calls the LLM to generate response text
      const actionContext = {
        conversation: context,
        llm: this.llm,
        tools: this.tools,
        memory: this.memory,
        session: this.session,
      };

      const responseText = await match.action.handler(actionContext);

      // Add agent turn to memory
      this.memory.addTurn({
        role: "agent",
        content: responseText,
        timestampMs: Date.now() - this.session.startedAt.getTime(),
        actionId: match.action.id,
        confidence: match.confidence,
      });

      // Notify hooks
      await this.hooks.onAgentSpoke?.(responseText, this.session);

      // TTS — speak the response
      await this.speak(responseText);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.log("error", `Pipeline error: ${err.message}`);
      await this.hooks.onError?.(err, this.session);
      this.emit("error", err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Speak text through TTS and send audio back to the client.
   */
  private async speak(text: string): Promise<void> {
    if (!this.sendAudioFn) return;

    this.isSpeaking = true;
    this.emit("agentSpeaking", true);

    try {
      for await (const chunk of this.tts.synthesize(text)) {
        // Check if we've been interrupted (barge-in)
        if (!this.isSpeaking) break;

        await this.sendAudioFn(chunk);
      }
    } catch (error) {
      this.logger.log(
        "error",
        `TTS error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.isSpeaking = false;
      this.emit("agentSpeaking", false);
    }
  }

  /**
   * Handle barge-in — user interrupts while agent is speaking.
   * Stop TTS playback immediately and re-enter listening mode.
   */
  private handleBargeIn(): void {
    if (!this.isSpeaking) return;

    this.logger.log("info", "Barge-in detected — stopping agent speech");
    this.isSpeaking = false;
    this.hooks.onBargeIn?.(this.session);
    this.emit("bargeIn");
  }

  /** Get current pipeline state */
  get state(): { isSpeaking: boolean; isProcessing: boolean } {
    return {
      isSpeaking: this.isSpeaking,
      isProcessing: this.isProcessing,
    };
  }
}

export function createPipeline(
  options: ConstructorParameters<typeof VoicePipeline>[0],
): VoicePipeline {
  return new VoicePipeline(options);
}
