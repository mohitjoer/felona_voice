import { EventEmitter } from "node:events";
import type {
  AudioChunk,
  Session,
  STTProvider,
  STTStream,
  TTSProvider,
  VADProvider,
  AgentHooks,
  ActionContext,
  ActionMatch,
  ConversationContext,
  ConversationTurn,
  SessionAccessor,
  EndpointingOptions,
  InterruptionOptions,
  PreemptiveOptions,
  DTMFConfig,
  DTMFEvent,
} from "./types.js";
import { AudioPreprocessor } from "./audio/preprocess.js";
import { DTMFCollector } from "./audio/dtmf.js";
import { normalizeLanguage } from "./i18n/language.js";
import type { CallTransferProvider, TransferRequest, TransferResult } from "./telephony/transfer.js";
import { KnowledgeBase } from "./knowledge/kb.js";
import {
  analyzeCall,
  type AnalyzeOptions,
  type CallAnalysis,
} from "./analytics/call-analysis.js";
import { FastSemanticEmbeddingProvider } from "./jev/fast-embeddings.js";
import type { JEVEngine } from "./jev/engine.js";
import type { ConversationMemory } from "./memory/context.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { CallLogger, JEVDecisionLog } from "./analytics/logger.js";
import {
  createFelonaTracer,
  contentFingerprint,
  formatTraceContext,
  SPAN,
  type FelonaTracer,
} from "./observability/tracing.js";

/**
 * A routed turn awaiting commit.
 *
 * Planning and committing are separate so a preemptive attempt can be discarded
 * without having touched conversation state.
 */
interface TurnPlan {
  userText: string;
  responseText: string;
  match: ActionMatch;
  decisionLog: JEVDecisionLog;
  context: ConversationContext;
  speculative: boolean;
}

/**
 * A decision started before the user's turn was fully confirmed.
 *
 * Speculative: if the transcript changes before the turn closes, the attempt is
 * abandoned rather than spoken.
 */
interface PreemptiveAttempt {
  /** Transcript text this attempt was based on. */
  transcript: string;
  /** 1-based attempt number for this turn. */
  attempt: number;
  /** Set when a newer transcript supersedes this attempt. */
  abandoned: boolean;
  /** Resolves to the plan, or null if the attempt was abandoned. */
  result: Promise<TurnPlan | null>;
}

interface PreemptiveCandidate {
  transcript: string;
  attempt: PreemptiveAttempt;
  attemptCount: number;
}

/**
 * The session-store surface the pipeline uses: slot access for handlers, plus
 * turn recording and TTL refresh.
 */
export type PipelineSessionStore = SessionAccessor & {
  addTurn(id: string, turn: ConversationTurn): Promise<void>;
  touch(id: string): Promise<void>;
};

/**
 * A detected overlap between agent speech and user speech, before it has been
 * classified as a genuine interruption.
 */
interface InterruptionCandidate {
  /** When the overlap was first detected (session-relative ms). */
  startedAtMs: number;
  /** Last time speech was seen, used to measure sustained duration. */
  lastSpeechAtMs: number;
  /** Words transcribed during the overlap so far. */
  words: number;
  /** Index into `speechPlayback` where playback stopped. */
  resumeIndex: number;
  /** Timer that classifies the candidate as a false interruption. */
  timer: NodeJS.Timeout | null;
}

/**
 * VoicePipeline — Orchestrates the full voice conversation loop.
 *
 * Audio In → VAD → STT → JEV Decision → Action Handler → TTS → Audio Out
 *
 * One pipeline instance is created per active session (call).
 * It manages:
 * - Audio buffering and VAD-based turn detection
 * - Streaming STT transcription
 * - JEV-powered action selection
 * - Direct action handler execution (ultra-low-latency, no model in the loop)
 * - Streaming TTS playback
 * - Barge-in (user interruption) handling
 */
export class VoicePipeline extends EventEmitter {
  private readonly sessionId: string;
  private readonly session: Session;
  private readonly stt: STTProvider;
  private readonly tts: TTSProvider;
  private readonly vad: VADProvider;
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
  private bargeInCount = 0;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnQueued = false;
  private falseInterruptionTimer: NodeJS.Timeout | null = null;
  private interruptionCandidate: InterruptionCandidate | null = null;
  private preprocessor: AudioPreprocessor | null = null;
  private resumingPlayback = false;
  private readonly dtmf: DTMFCollector;
  private dtmfEnabled: boolean;
  private preemptiveCandidate: PreemptiveCandidate | null = null;
  /** Whether a final transcript has already landed for the current turn. */
  private turnHasFinal = false;
  /** Transfer requested by the current turn's action handler, run after speech. */
  private pendingTransfer: TransferRequest | null = null;

  /**
   * Audio already sent (or queued to send) for the current agent utterance.
   *
   * Kept so a false interruption can resume playback exactly where it stopped,
   * instead of re-synthesizing — which would cost money and change the timing.
   */
  private readonly speechPlayback: AudioChunk[] = [];
  private speechPlaybackIndex = 0;

  /** Resolved in start() once the STT stream exists. */
  private turnDetection: "vad" | "stt";
  private readonly endpointing: Required<EndpointingOptions>;
  private readonly interruption: Required<InterruptionOptions>;
  private readonly preemptive: Required<PreemptiveOptions>;

  /** Rolling statistics used by `endpointing.mode: "dynamic"`. */
  private readonly observedPausesMs: number[] = [];
  private adaptiveMinDelayMs: number;
  private lastSpeechTimestampMs = 0;

  /**
   * Coalescing window after VAD reports speech end. Deepgram and AssemblyAI
   * emit their endpointing final on their own schedule, so the turn is not
   * submitted the instant the VAD hangover expires.
   */
  private static readonly TURN_DEBOUNCE_MS = 120;

  /**
   * How long to wait for a final transcript from a provider that does not
   * implement `flush()`. Without this, a turn is submitted on a partial
   * transcript whenever the recognizer is slower than the VAD hangover.
   */
  private static readonly STT_GRACE_MS = 700;

  // Callback to send audio back to the client
  private sendAudioFn: ((chunk: AudioChunk) => Promise<void>) | null = null;
  // Callback to clear queued audio on telephony (e.g. Twilio barge-in)
  private clearAudioFn: (() => Promise<void>) | null = null;
  private sessionManager: PipelineSessionStore | null = null;
  private readonly sttFlushTimeoutMs: number;
  /** Language passed to the STT provider. */
  private readonly sttLanguage?: string;
  private readonly transferProvider: CallTransferProvider | null;
  private readonly knowledge: KnowledgeBase;
  private readonly tracer: FelonaTracer;
  private readonly analysisOptions: AnalyzeOptions | undefined;
  /** Populated when the call ends. */
  private analysis: CallAnalysis | null = null;

  constructor(options: {
    sessionId: string;
    session: Session;
    stt: STTProvider;
    tts: TTSProvider;
    vad: VADProvider;
    jev: JEVEngine;
    memory: ConversationMemory;
    tools: ToolRegistry;
    logger: CallLogger;
    hooks: AgentHooks;
    systemPrompt: string;
    sendAudio: (chunk: AudioChunk) => Promise<void>;
    clearAudio?: () => Promise<void>;
    sessionManager?: PipelineSessionStore;
    /** How long to wait for a final transcript before submitting the turn (ms) */
    sttFlushTimeoutMs?: number;
    /** Input audio conditioning. Omit or disable to pass audio through untouched. */
    preprocessor?: AudioPreprocessor | null;
    endpointing?: EndpointingOptions;
    interruption?: InterruptionOptions;
    preemptive?: PreemptiveOptions;
    dtmf?: DTMFConfig;
    /**
     * BCP-47 tag, or a list of tags to auto-detect between. Forwarded to the
     * STT provider; a provider that expects a single tag receives the first.
     */
    language?: string | string[];
    /**
     * Telephony operations for call transfer. Omitted when the deployment
     * cannot transfer, in which case `ctx.transfer` is undefined and the agent
     * must say so rather than claiming to escalate.
     */
    transferProvider?: CallTransferProvider | null;
    /** Retrieval over the agent's documentation. Defaults to an empty base. */
    knowledge?: KnowledgeBase;
    /**
     * OpenTelemetry instrumentation for this call. Defaults to a tracer on the
     * global OpenTelemetry API, which is a no-op until the application
     * registers a provider.
     */
    tracer?: FelonaTracer;
    /**
     * How to judge the call when it ends. Forwarded to `analyzeCall`.
     *
     * Without this the analysis can only guess from the transcript, which is
     * fine for exploration and wrong for anything that bills or escalates on it.
     */
    analysis?: AnalyzeOptions;
  }) {
    super();
    this.sessionId = options.sessionId;
    this.session = options.session;
    this.stt = options.stt;
    this.tts = options.tts;
    this.vad = options.vad;
    this.jev = options.jev;
    this.memory = options.memory;
    this.tools = options.tools;
    this.logger = options.logger;
    this.hooks = options.hooks;
    this.systemPrompt = options.systemPrompt;
    this.sendAudioFn = options.sendAudio;
    this.clearAudioFn = options.clearAudio ?? null;
    this.sessionManager = options.sessionManager ?? null;
    this.sttFlushTimeoutMs = options.sttFlushTimeoutMs ?? 1500;
    this.sttLanguage = normalizeLanguage(options.language);
    this.preprocessor = options.preprocessor ?? null;
    this.transferProvider = options.transferProvider ?? null;
    this.knowledge = options.knowledge ?? new KnowledgeBase({
      embeddingProvider: new FastSemanticEmbeddingProvider(),
    });
    this.tracer = options.tracer ?? createFelonaTracer();
    this.analysisOptions = options.analysis;

    // Endpointing. `auto` prefers the recognizer's own signal, but that can
    // only be determined once a real stream exists — asking the provider
    // whether it supports flush() by creating a stream would open a second
    // live connection. Resolution happens in start().
    this.endpointing = {
      detection: options.endpointing?.detection ?? "auto",
      minDelayMs: options.endpointing?.minDelayMs ?? 800,
      maxDelayMs: options.endpointing?.maxDelayMs ?? 3000,
      mode: options.endpointing?.mode ?? "fixed",
    };
    this.turnDetection = "vad";
    this.adaptiveMinDelayMs = this.endpointing.minDelayMs;

    this.interruption = {
      enabled: options.interruption?.enabled ?? true,
      mode: options.interruption?.mode ?? "adaptive",
      minSpeechMs: options.interruption?.minSpeechMs ?? 500,
      minWords: options.interruption?.minWords ?? 0,
      falseInterruptionTimeoutMs: options.interruption?.falseInterruptionTimeoutMs ?? 2000,
      resumeOnFalseInterruption: options.interruption?.resumeOnFalseInterruption ?? true,
    };

    this.preemptive = {
      enabled: options.preemptive?.enabled ?? true,
      maxSpeechMs: options.preemptive?.maxSpeechMs ?? 10000,
      maxRetries: options.preemptive?.maxRetries ?? 3,
    };

    this.dtmfEnabled = options.dtmf?.enabled ?? true;
    this.dtmf = new DTMFCollector({
      expectedDigits: options.dtmf?.expectedDigits,
      terminateOn: options.dtmf?.terminateOn,
      idleTimeoutMs: options.dtmf?.idleTimeoutMs,
    });
  }

  /**
   * Handle a keypad digit from the transport.
   *
   * Tones are not speech, so they never reach the STT stream. Once the
   * configured entry completes, the digits are submitted as the turn's input so
   * the agent actually responds to a spoken-back PIN or menu choice.
   */
  handleDTMF(digit: string): void {
    if (!this.dtmfEnabled) return;

    const timestampMs = Date.now() - this.session.startedAt.getTime();
    const entry = this.dtmf.push(digit, timestampMs);
    if (!entry) return;

    this.emit("dtmf", { digit, sessionId: this.sessionId, timestampMs } satisfies DTMFEvent);

    if (!entry.complete) {
      this.emit("dtmfPartial", { digits: entry.digits, sessionId: this.sessionId });
      return;
    }

    this.logger.log("info", `DTMF entry complete: ${entry.digits.length} digits`);
    this.emit("dtmfEntry", { digits: entry.digits, sessionId: this.sessionId });

    // Answer the entry as a turn so the caller gets a spoken response.
    this.currentTranscript = entry.digits;
    this.turnHasFinal = true;
    this.scheduleTurnComplete();
  }

  /** Keypad digits buffered so far, for handlers that want partial input. */
  get dtmfDigits(): string {
    return this.dtmf.value;
  }

  /**
   * Start the pipeline — initialize STT stream and begin processing.
   */
  async start(): Promise<void> {
    this.logger.log("info", `Pipeline started for session ${this.sessionId}`);

    // Create STT stream
    this.sttStream = this.stt.createStream({
      interimResults: true,
      language: this.sttLanguage,
      flushTimeoutMs: this.sttFlushTimeoutMs,
    });

    // Handle STT results
    this.sttStream.onResult((result) => {
      this.handleSTTResult(result);
    });

    // Surface recognizer failures (auth, network, protocol) without taking
    // the process down.
    this.sttStream.onError?.((error) => {
      this.handleStreamError(error);
    });

    // Notify hooks
    await this.hooks.onCallStart?.(this.session);

    this.resolveTurnDetection();

    this.emit("started");
  }

  /**
   * Decide whether to endpoint on VAD or on the recognizer's own signal.
   */
  private resolveTurnDetection(): void {
    const requested = this.endpointing.detection;
    const sttCapable = typeof this.sttStream?.flush === "function";

    if (requested === "stt" && !sttCapable) {
      this.logger.log(
        "warn",
        `endpointing.detection "stt" requested but ${this.stt.name} has no flush(); falling back to VAD endpointing`,
      );
      this.turnDetection = "vad";
      return;
    }

    this.turnDetection = requested === "auto" ? (sttCapable ? "stt" : "vad") : requested;

    this.logger.log(
      "info",
      `Turn detection: ${this.turnDetection === "stt" ? "STT endpointing" : "energy VAD"} ` +
        `(mode: ${this.endpointing.mode}, min ${this.endpointing.minDelayMs}ms, max ${this.endpointing.maxDelayMs}ms)`,
    );
  }

  /**
   * Effective silence window before a turn closes.
   *
   * In `dynamic` mode this tracks the median observed pause, so a caller with
   * long pauses is not cut off and one with short pauses is not left waiting.
   */
  private get effectiveMinDelayMs(): number {
    if (this.endpointing.mode !== "dynamic" || this.observedPausesMs.length < 5) {
      return this.endpointing.minDelayMs;
    }

    const sorted = [...this.observedPausesMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Nudge above the median: cutting a speaker off is worse than pausing.
    const adapted = Math.round(median * 1.15);
    return Math.max(
      this.endpointing.minDelayMs,
      Math.min(this.endpointing.maxDelayMs, adapted),
    );
  }

  /**
   * Process incoming audio from the transport.
   * This is called for every audio chunk received from the client.
   */
  processAudio(chunk: AudioChunk): void {
    // Step 0: Condition the audio before anything reads it. A cleaner signal
    // improves VAD accuracy, STT accuracy and turn detection at once.
    let audio = chunk;
    if (this.preprocessor) {
      const conditioned = this.preprocessor.process(chunk);
      audio = { ...chunk, data: conditioned };
    }

    // Step 1: VAD — detect if the user is speaking
    const vadResult = this.vad.process(audio);
    if (vadResult.isSpeech) this.lastSpeechTimestampMs = chunk.timestampMs;

    if (vadResult.event?.type === "speech_start") {
      // The user started talking again before the previous turn was submitted —
      // keep accumulating into the same turn.
      this.clearTurnTimer();

      // Step 2: Handle overlap with agent speech
      if (this.isSpeaking) {
        this.beginInterruptionCandidate(chunk.timestampMs);
      }
    } else if (vadResult.event?.type === "speech_end") {
      this.closeInterruptionCandidate();
    }

    // While an interruption candidate is open, sustained speech extends it.
    if (this.interruptionCandidate && vadResult.isSpeech) {
      this.extendInterruptionCandidate(chunk.timestampMs);
    }

    // Step 3: Feed audio to STT (only when speech is detected)
    if (vadResult.isSpeech && this.sttStream) {
      this.sttStream.write(audio);
    }

    // Step 4: Turn completion
    if (vadResult.event?.type === "speech_end") {
      this.scheduleTurnComplete(chunk.timestampMs);
    }
  }

  /**
   * Stop the pipeline — clean up resources.
   */
  async stop(): Promise<void> {
    this.clearTurnTimer();
    this.clearCandidateTimer();
    this.turnQueued = false;
    this.interruptionCandidate = null;
    // A transfer staged by a turn that never completed must not fire on hangup.
    this.pendingTransfer = null;

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
        bargeInCount: this.bargeInCount,
        avgConfidence: this.decisions.length > 0
          ? this.decisions.reduce((sum, d) => sum + d.confidence, 0) / this.decisions.length
          : 0,
      },
    });

    // Close STT stream
    await this.sttStream?.close();

    // Post-call analysis, computed on the way out while the turns are still in
    // memory. Returns a value; nothing is written unless a logDir was given.
    const analysis = await this.tracer.span(
      SPAN.callEnd,
      {
        "felona.session.id": this.sessionId,
        "felona.call.turn_count": this.memory.length,
        "felona.call.barge_in_count": this.bargeInCount,
        "felona.call.duration_ms": Date.now() - this.session.startedAt.getTime(),
      },
      (span) => {
        // Synchronous: the analysis is pure, so there is nothing to await.
        const result = analyzeCall(
          this.session,
          this.memory.getTurns(),
          this.decisions,
          this.analysisOptions,
        );
        // Barge-ins are a strong signal the conversation was not going well.
        if (this.bargeInCount > 0 && result.sentiment.label === "neutral") {
          result.sentiment.label = "negative";
          result.escalationRisk = true;
        }
        span.setAttribute("felona.call.resolved", result.resolved);
        span.setAttribute("felona.call.escalation_risk", result.escalationRisk);
        span.setAttribute("felona.call.outcome_score", result.outcomeScore);
        return result;
      },
    );
    this.analysis = analysis;
    this.logger.log("info", `Call analysis: ${analysis.summary}`);

    // Notify hooks
    await this.hooks.onCallEnd?.(this.session, this.memory.getTurns());

    this.emit("callAnalysis", analysis);
    this.logger.log("info", `Pipeline stopped for session ${this.sessionId}`);
    this.emit("stopped");
  }

  /**
   * Emit only when someone is listening.
   *
   * `error` is special-cased by Node's EventEmitter: emitting it with no
   * registered listener throws, which would turn any pipeline hiccup into a
   * process crash. Errors are always logged, so dropping the event when
   * nobody cares costs nothing.
   */
  private emitSafe(event: string, ...args: unknown[]): void {
    if (this.listenerCount(event) > 0) {
      this.emit(event, ...args);
    }
  }

  /**
   * Handle a failure reported by the STT stream.
   */
  private handleStreamError(error: Error): void {
    this.logger.log("error", `STT error: ${error.message}`);
    void this.hooks.onError?.(error, this.session);
    this.emitSafe("sttError", error);
  }

  /**
   * Schedule turn processing after the endpointing delay.
   *
   * In `stt` mode the recognizer's own `flush()` decides when the turn is
   * complete, so the VAD hangover only needs to trigger the flush rather than
   * gate the turn. The delay is capped by `maxDelayMs` so a stuck VAD can
   * never swallow a turn indefinitely.
   */
  private scheduleTurnComplete(timestampMs?: number): void {
    if (this.isProcessing) {
      // A turn is already in flight; run this one as soon as it finishes.
      this.turnQueued = true;
      return;
    }

    this.clearTurnTimer();

    const delay = this.turnDetection === "stt"
      ? VoicePipeline.TURN_DEBOUNCE_MS
      : this.effectiveMinDelayMs;

    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      void this.handleUserTurnComplete();
    }, delay);
    this.turnTimer.unref?.();

    if (this.endpointing.mode === "dynamic" && timestampMs !== undefined) {
      this.recordObservedPause(timestampMs);
    }
  }

  /**
   * Track the gap between the last speech frame and the turn actually closing,
   * so `dynamic` endpointing can adapt to this speaker.
   */
  private recordObservedPause(timestampMs: number): void {
    const pause = timestampMs - this.lastSpeechTimestampMs;
    if (pause <= 0 || pause > this.endpointing.maxDelayMs) return;

    this.observedPausesMs.push(pause);
    if (this.observedPausesMs.length > 50) this.observedPausesMs.shift();
    this.adaptiveMinDelayMs = this.effectiveMinDelayMs;
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  /**
   * Resolve once the audio captured for this turn has been transcribed.
   *
   * Prefers the stream's own `flush()` (which for batch providers such as
   * Whisper, Azure and Google actually performs the transcription request).
   * Providers without `flush()` get a fixed grace period for their
   * endpointing final.
   */
  private async finalizeTranscript(): Promise<string> {
    const stream = this.sttStream;

    if (stream?.flush) {
      try {
        await stream.flush();
      } catch (error) {
        this.logger.log(
          "error",
          `STT flush failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (this.currentTranscript) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, VoicePipeline.STT_GRACE_MS);
        if (typeof timer.unref === "function") timer.unref();
      });
    }

    return this.currentTranscript.trim();
  }

  /**
   * Start deciding as soon as a transcript settles, overlapping the remaining
   * endpointing wait.
   *
   * The attempt is speculative. A later final that changes the text abandons it
   * and starts over, so a mutated utterance is never answered from a stale
   * guess — the saving is latency, not accuracy.
   */
  private startPreemptive(transcript: string): void {
    if (!this.preemptive.enabled || this.isProcessing) return;
    if (!transcript.trim()) return;
    if (this.preemptiveCandidate?.transcript === transcript) return;

    const attemptCount = (this.preemptiveCandidate?.attemptCount ?? 0) + 1;
    if (attemptCount > this.preemptive.maxRetries) {
      this.logger.log("debug", "Preemptive attempt cap reached; awaiting turn confirmation");
      return;
    }

    // Abandon whatever was in flight; its answer no longer matches the input.
    if (this.preemptiveCandidate) {
      this.preemptiveCandidate.attempt.abandoned = true;
    }

    const attempt: PreemptiveAttempt = {
      transcript,
      attempt: attemptCount,
      abandoned: false,
      result: Promise.resolve(null),
    };

    attempt.result = this.runPreemptive(transcript, attempt);

    this.preemptiveCandidate = { transcript, attempt, attemptCount };
    this.logger.log("debug", `Preemptive attempt ${attemptCount} for "${transcript.slice(0, 60)}"`);
  }

  private async runPreemptive(
    transcript: string,
    attempt: PreemptiveAttempt,
  ): Promise<TurnPlan | null> {
    try {
      const plan = await this.planTurn(transcript, { speculative: true });
      return attempt.abandoned ? null : plan;
    } catch (error) {
      // A speculative failure is never fatal: the confirmed path will retry.
      this.logger.log(
        "debug",
        `Preemptive attempt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Abandon any in-flight preemptive attempt.
   *
   * Used when the turn is being abandoned or the session is ending — not when
   * the attempt is about to be consumed.
   */
  private clearPreemptive(): void {
    if (this.preemptiveCandidate) {
      this.preemptiveCandidate.attempt.abandoned = true;
      this.preemptiveCandidate = null;
    }
  }

  /**
   * Handle a STT transcription result.
   */
  private handleSTTResult(result: {
    text: string;
    isFinal: boolean;
    confidence: number;
  }): void {
    // Feed the open interruption candidate: `minWords` needs a real count of
    // what the caller said, which is the only reliable way to tell "uh-huh"
    // from "wait, stop".
    if (this.interruptionCandidate) {
      const text = result.text.trim();
      if (text) {
        this.interruptionCandidate.words = text.split(/\s+/).filter(Boolean).length;
        this.extendInterruptionCandidate(Date.now() - this.session.startedAt.getTime());
      }
    }

    if (result.isFinal) {
      // Within one turn there is a single utterance. Recognizers differ in how
      // they report it: most send one final, but some send progressive finals
      // that revise the previous one. Appending blindly would produce
      // "where is my where is my order", so a second final replaces rather
      // than extends.
      if (this.turnHasFinal) {
        this.currentTranscript = result.text;
      } else {
        this.currentTranscript += (this.currentTranscript ? " " : "") + result.text;
        this.turnHasFinal = true;
      }

      this.emit("transcript", {
        text: this.currentTranscript,
        isFinal: true,
      });
      this.startPreemptive(this.currentTranscript);
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
   * This triggers the JEV → action handler → TTS pipeline.
   */
  private async handleUserTurnComplete(): Promise<void> {
    if (this.isProcessing) {
      this.turnQueued = true;
      return;
    }

    this.isProcessing = true;

    // Snapshot and clear the buffer *after* awaiting the final transcript, so
    // anything the user says while we wait lands in the next turn rather than
    // being wiped.
    const userText = await this.finalizeTranscript();
    this.currentTranscript = "";
    this.turnHasFinal = false;

    // Reuse the speculative decision when it was based on exactly this text.
    // Detach without abandoning: this attempt is about to be read, and marking
    // it abandoned here would guarantee the speculative work is thrown away and
    // the turn recomputed from scratch.
    const candidate = this.preemptiveCandidate;
    this.preemptiveCandidate = null;

    if (!userText) {
      this.isProcessing = false;
      this.drainQueuedTurn();
      return; // Ignore empty turns
    }

    try {
      // The whole turn is one span, so a trace shows the caller turn and every
      // stage under it. The fingerprint identifies the utterance without putting
      // the caller's words into a store we do not control.
      await this.tracer.span(
        SPAN.turn,
        {
          "felona.session.id": this.sessionId,
          "felona.turn.fingerprint": contentFingerprint(userText),
          "felona.turn.char_count": userText.length,
          "felona.turn.reused_speculation": Boolean(
            candidate && candidate.transcript === userText,
          ),
        },
        async (turnSpan) => {
          // Reuse the speculative plan only when it was based on exactly this text
          // and actually completed; otherwise plan and commit afresh.
          const reusable =
            candidate && candidate.transcript === userText
              ? await candidate.attempt.result
              : null;

          const plan = reusable ?? (await this.planTurn(userText));
          const responseText = await this.commitTurn({ ...plan, speculative: false });

          turnSpan.setAttribute("felona.turn.response_char_count", responseText.length);

          // TTS — speak the response
          await this.speak(responseText);

          // Only now redirect the call, so the caller hears the whole reply — and
          // so a warm transfer's introduction is not cut off mid-sentence.
          await this.runPendingTransfer();
        },
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.log(
        "error",
        `Pipeline error: ${err.message}${formatTraceContext()}`,
      );
      await this.hooks.onError?.(err, this.session);
      this.emitSafe("error", err);
    } finally {
      this.isProcessing = false;
      this.drainQueuedTurn();
    }
  }

  /**
   * Route one utterance and produce the reply, without recording anything.
   *
   * Deliberately free of side effects on conversation state: the same plan can
   * be computed speculatively and then either committed or thrown away. A
   * speculative run that mutated memory would leave a duplicate turn behind
   * whenever the transcript changed.
   *
   * (Handlers may still write slots, which are expected to be idempotent.)
   */
  private async planTurn(
    userText: string,
    options: { speculative?: boolean } = {},
  ): Promise<TurnPlan> {
    // Build conversation context from a snapshot that already includes this
    // utterance, matching what a confirmed run would see.
    const provisionalTurn: ConversationTurn = {
      role: "user",
      content: userText,
      timestampMs: Date.now() - this.session.startedAt.getTime(),
    };

    const context = this.memory.buildContext(
      this.session,
      this.systemPrompt,
      userText,
    );

    // Routing is the core of the framework, so it is the span worth having: it
    // shows what JEV chose, how confident it was, and how long the prediction
    // took against the rest of the turn.
    const { match, jevLatencyMs } = await this.tracer.span(
      SPAN.jevDecide,
      {
        "felona.session.id": this.sessionId,
        "felona.context.turn_count": context.turns.length,
        "felona.context.slot_count": Object.keys(context.slots).length,
        "felona.jev.speculative": options.speculative === true,
        "felona.turn.fingerprint": contentFingerprint(userText),
      },
      async (span) => {
        const startTime = performance.now();
        const decision = await this.jev.decide(context);
        const latencyMs = performance.now() - startTime;
        span.setAttribute("felona.jev.latency_ms", latencyMs);
        span.setAttribute("felona.jev.selected_action", decision.action.id);
        span.setAttribute("felona.jev.confidence", decision.confidence);
        return { match: decision, jevLatencyMs: latencyMs };
      },
    );

    const decisionLog: JEVDecisionLog = {
      timestampMs: provisionalTurn.timestampMs,
      contextSummary: userText.slice(0, 200),
      selectedAction: match.action.id,
      confidence: match.confidence,
      candidates: match.candidates.slice(0, 5),
      latencyMs: jevLatencyMs,
    };

    const actionContext: ActionContext = {
      conversation: context,
      tools: this.tools,
      memory: this.memory,
      session: this.session,
      // Omitted rather than null when no store is attached, so handlers can
      // distinguish "no session store" from "empty store".
      ...(this.sessionManager ? { sessions: this.sessionManager } : {}),
      ...(this.dtmfDigits ? { dtmf: this.dtmfDigits } : {}),
      // Omitted entirely when the deployment cannot transfer, so a handler can
      // tell "no transfer available" from "transfer failed".
      ...(this.transferProvider ? { transfer: this.stageTransfer } : {}),
      // Present even when the knowledge base is empty, so a handler can search
      // without branching; an empty base simply returns no passages.
      knowledge: {
        search: (query: string, searchOptions?: { topK?: number; minScore?: number }) =>
          this.knowledge.search(query, searchOptions),
      },
    };

    // The handler is where an LLM call or a tool call usually happens, so
    // giving it its own span is what makes a slow reply explainable.
    const responseText = await this.tracer.span(
      SPAN.actionHandler,
      {
        "felona.action.id": match.action.id,
        "felona.jev.confidence": match.confidence,
      },
      async (span) => {
        const text = await match.action.handler(actionContext);
        span.setAttribute("felona.action.response_char_count", text.length);
        return text;
      },
    );

    this.logger.log(
      "info",
      `JEV selected: "${match.action.id}" (confidence: ${match.confidence.toFixed(3)}, ` +
        `latency: ${jevLatencyMs.toFixed(1)}ms${options.speculative ? ", preemptive" : ""})`,
    );

    return {
      userText,
      responseText,
      match,
      decisionLog,
      context,
      speculative: options.speculative === true,
    };
  }

  /**
   * Record a planned turn: conversation memory, session store, hooks and
   * analytics. Separate from planning so a speculative attempt can be dropped
   * without leaving traces.
   */
  private async commitTurn(plan: TurnPlan): Promise<string> {
    const userTurn: ConversationTurn = {
      role: "user",
      content: plan.userText,
      timestampMs: Date.now() - this.session.startedAt.getTime(),
    };
    this.memory.addTurn(userTurn);
    void this.sessionManager?.addTurn(this.sessionId, userTurn);

    await this.hooks.onUserSpoke?.(plan.userText, this.session);
    await this.hooks.onActionSelected?.(
      plan.match.action,
      plan.match.confidence,
      plan.context,
    );

    const agentTurn: ConversationTurn = {
      role: "agent",
      content: plan.responseText,
      timestampMs: Date.now() - this.session.startedAt.getTime(),
      actionId: plan.match.action.id,
      confidence: plan.match.confidence,
    };
    this.memory.addTurn(agentTurn);
    void this.sessionManager?.addTurn(this.sessionId, agentTurn);
    void this.sessionManager?.touch(this.sessionId);

    await this.hooks.onAgentSpoke?.(plan.responseText, this.session);

    // A committed decision is real: it belongs in analytics and in the
    // training data. Speculative ones never get here.
    this.decisions.push(plan.decisionLog);
    this.logger.logDecision(plan.decisionLog);

    return plan.responseText;
  }

  /**
   * Run a turn that arrived while another was being processed.
   */
  private drainQueuedTurn(): void {
    if (!this.turnQueued) return;
    this.turnQueued = false;
    this.scheduleTurnComplete();
  }

  /**
   * Record a transfer requested by an action handler.
   *
   * Runs after the reply has finished playing — see `runPendingTransfer`.
   */
  private stageTransfer = (request: TransferRequest): void => {
    this.pendingTransfer = request;
  };

  /**
   * Perform the transfer staged by the current turn.
   *
   * Called once the agent's reply has finished, so a warm transfer's
   * introduction is heard in full before the line changes. Failures are
   * reported rather than thrown: the call is still live, so the agent should get
   * a chance to tell the caller rather than the session dying silently.
   */
  private async runPendingTransfer(): Promise<TransferResult | null> {
    const request = this.pendingTransfer;
    this.pendingTransfer = null;
    if (!request || !this.transferProvider) return null;

    if (!this.transferProvider.canTransfer(this.session)) {
      const result: TransferResult = {
        success: false,
        mode: request.mode ?? "cold",
        to: request.to,
        error: "this call cannot be transferred",
      };
      this.logger.log("warn", `Transfer to ${request.to} unavailable: ${result.error}`);
      this.emitSafe("transferFailed", result);
      return result;
    }

    this.logger.log("info", `Transferring call to ${request.to} (${request.mode ?? "cold"})`);
    this.emit("transferring", { to: request.to, mode: request.mode ?? "cold" });

    // A transfer is usually the end of the call, so its span is the last thing
    // in the turn's trace. `to` is a destination the agent chose, not something
    // the caller said, so it is safe to record.
    const result = await this.tracer.span(
      SPAN.transfer,
      {
        "felona.session.id": this.sessionId,
        "felona.transfer.to": request.to,
        "felona.transfer.mode": request.mode ?? "cold",
      },
      async (span) => {
        const outcome = await this.transferProvider!.transfer(this.session, request);
        span.setAttribute("felona.transfer.ok", outcome.success);
        return outcome;
      },
    );

    if (result.success) {
      this.logger.log("info", `Transfer to ${request.to} accepted`);
      this.emit("transferred", result);
    } else {
      this.logger.log("error", `Transfer to ${request.to} failed: ${result.error}`);
      this.emitSafe("transferFailed", result);
    }

    return result;
  }

  /**
   * Speak text through TTS and send audio back to the client.
   */
  private async speak(text: string): Promise<void> {
    const sendAudio = this.sendAudioFn;
    if (!sendAudio) return;

    this.isSpeaking = true;
    // Record every chunk so a false interruption can resume playback exactly
    // where it stopped, without paying for a second synthesis.
    this.speechPlayback.length = 0;
    this.speechPlaybackIndex = 0;
    this.emit("agentSpeaking", true);

    try {
      // Spans synthesis and playback together, because for a voice call the
      // time to first audio is the number that matters — a slow synth and a
      // slow socket look identical from the caller's side.
      await this.tracer.span(
        SPAN.ttsSpeak,
        {
          "felona.session.id": this.sessionId,
          "felona.tts.char_count": text.length,
          "felona.tts.provider": this.tts.name,
        },
        async (span) => {
          let firstChunkMs: number | undefined;
          const start = performance.now();

          for await (const chunk of this.tts.synthesize(text)) {
            // Check if we've been interrupted (barge-in)
            if (!this.isSpeaking) break;

            await sendAudio(chunk);
            this.speechPlayback.push(chunk);

            if (firstChunkMs === undefined) {
              firstChunkMs = performance.now() - start;
              span.setAttribute("felona.tts.first_audio_ms", firstChunkMs);
            }
            span.setAttribute("felona.tts.chunks", this.speechPlayback.length);
          }

          if (!this.isSpeaking) {
            // Barge-in, not a failure: the caller started talking over us.
            span.setAttribute("felona.tts.interrupted", true);
          }
        },
      );
    } catch (error) {
      this.logger.log(
        "error",
        `TTS error: ${error instanceof Error ? error.message : String(error)}${formatTraceContext()}`,
      );
    } finally {
      this.speechPlaybackIndex = this.speechPlayback.length;
      this.clearCandidateTimer();
      this.interruptionCandidate = null;
      this.isSpeaking = false;
      this.emit("agentSpeaking", false);
    }
  }

  /**
   * Begin evaluating whether detected speech is a real interruption.
   *
   * In `immediate` mode this is the old behaviour: stop at once. In `adaptive`
   * mode playback continues while the speech is qualified, so a cough or an
   * "uh-huh" does not permanently silence the agent.
   */
  private beginInterruptionCandidate(timestampMs: number): void {
    if (!this.interruption.enabled || !this.isSpeaking) return;

    if (this.interruption.mode === "immediate") {
      this.commitInterruption();
      return;
    }

    if (this.interruptionCandidate) return;

    this.interruptionCandidate = {
      startedAtMs: timestampMs,
      lastSpeechAtMs: timestampMs,
      words: 0,
      resumeIndex: this.speechPlaybackIndex,
      timer: null,
    };

    // If nothing convincing follows, this was noise: put the audio back.
    this.interruptionCandidate.timer = setTimeout(() => {
      void this.classifyFalseInterruption();
    }, this.interruption.falseInterruptionTimeoutMs);
    this.interruptionCandidate.timer.unref?.();

    this.logger.log("debug", "Interruption candidate opened — awaiting qualification");
  }

  /** Track sustained speech and transcribed words for the open candidate. */
  private extendInterruptionCandidate(timestampMs: number): void {
    const candidate = this.interruptionCandidate;
    if (!candidate) return;

    candidate.lastSpeechAtMs = timestampMs;

    const speechMs = candidate.lastSpeechAtMs - candidate.startedAtMs;
    const durationOk = speechMs >= this.interruption.minSpeechMs;
    const wordsOk = this.interruption.minWords === 0 || candidate.words >= this.interruption.minWords;

    if (durationOk && wordsOk) {
      this.commitInterruption();
    }
  }

  /**
   * Speech stopped. Close the candidate if the bar was not met, or leave the
   * false-interruption timer to run if a transcript is still expected.
   */
  private closeInterruptionCandidate(): void {
    const candidate = this.interruptionCandidate;
    if (!candidate) return;

    const speechMs = candidate.lastSpeechAtMs - candidate.startedAtMs;
    const durationOk = speechMs >= this.interruption.minSpeechMs;
    const wordsOk = this.interruption.minWords === 0 || candidate.words >= this.interruption.minWords;

    if (durationOk && wordsOk) {
      this.commitInterruption();
      return;
    }

    // Short burst: a cough, a door, a single syllable. Resume now rather than
    // making the caller wait out the full false-interruption window.
    this.logger.log(
      "debug",
      `Interruption candidate rejected after ${speechMs}ms / ${candidate.words} words`,
    );
    void this.classifyFalseInterruption();
  }

  /**
   * Treat the overlap as noise and resume playback from where it stopped.
   */
  private async classifyFalseInterruption(): Promise<void> {
    const candidate = this.interruptionCandidate;
    if (!candidate) return;

    this.clearCandidateTimer();
    this.interruptionCandidate = null;

    if (!this.interruption.resumeOnFalseInterruption) {
      this.commitInterruption();
      return;
    }

    if (!this.isSpeaking) {
      // Playback already finished on its own; nothing to resume.
      return;
    }

    this.logger.log("info", "False interruption — resuming agent speech");
    this.emit("falseInterruption");

    const remaining = this.speechPlayback.slice(candidate.resumeIndex);
    if (remaining.length === 0) return;

    this.resumingPlayback = true;
    try {
      for (const chunk of remaining) {
        // A real interruption during replay aborts the resume.
        if (!this.isSpeaking) break;
        await this.sendAudioFn?.(chunk);
      }
    } finally {
      this.resumingPlayback = false;
    }
  }

  private clearCandidateTimer(): void {
    if (this.interruptionCandidate?.timer) {
      clearTimeout(this.interruptionCandidate.timer);
      this.interruptionCandidate.timer = null;
    }
  }

  /**
   * Accept the overlap as a genuine barge-in: stop speaking and clear whatever
   * audio the transport has queued.
   */
  private commitInterruption(): void {
    this.clearCandidateTimer();
    this.interruptionCandidate = null;

    if (!this.isSpeaking) return;

    this.logger.log("info", "Barge-in detected — stopping agent speech");
    this.bargeInCount++;
    this.isSpeaking = false;
    this.speechPlaybackIndex = this.speechPlayback.length;
    void this.clearAudioFn?.();
    void this.hooks.onBargeIn?.(this.session);
    this.emit("bargeIn");
  }

  /**
   * Handle barge-in — user interrupts while agent is speaking.
   * Stop TTS playback immediately and re-enter listening mode.
   */
  private handleBargeIn(): void {
    if (!this.interruption.enabled) return;
    this.commitInterruption();
  }

  /** Number of barge-in interruptions observed on this call */
  get bargeIns(): number {
    return this.bargeInCount;
  }

  /** Post-call analysis, available once the call has ended. */
  get callAnalysis(): CallAnalysis | null {
    return this.analysis;
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
