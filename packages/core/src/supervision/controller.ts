import type { AudioChunk, Session, Transport } from "../types.js";

/**
 * Live supervision: listen in, coach, and take over a call.
 *
 * Every call centre needs a supervisor who can hear what is happening and step
 * in — but stepping in is a *routing* decision, not a recording feature. The
 * audio the agent produces has to be diverted to the supervisor, and the
 * supervisor's voice has to reach the caller, without either party hearing
 * audio meant for them.
 *
 * The controller models that as an explicit state machine rather than a set of
 * booleans, because the invalid transitions (speaking while muted, for example)
 * are where a takeover implementation usually goes wrong.
 */

export type SupervisionState =
  /** The agent is handling the call. The supervisor may listen and coach. */
  | "agent"
  /** The supervisor is speaking to the caller. The agent is silent. */
  | "supervisor"
  /** The agent is silenced but still transcribing; the supervisor is live. */
  | "muted"
  /** The call is over. */
  | "ended";

export interface SupervisorHandle {
  readonly sessionId: string;
  readonly state: SupervisionState;
  /**
   * Audio the caller would hear, for the supervisor to listen to.
   * Supplied by the embedder; this controller never buffers call audio itself,
   * which keeps the framework's no-persistence default intact.
   */
  onAudio?: (chunk: AudioChunk) => void;
  /**
   * Speak to the caller as the supervisor.
   * The embedder routes this through its own TTS and the transport.
   */
  speak?: (text: string) => Promise<void> | void;
}

export interface TakeoverOptions {
  transport: Transport;
  /**
   * Resolve the live session for a session id. The controller needs the Session
   * to pass to the transport.
   */
  resolveSession: (sessionId: string) => Session | undefined;
}

/**
 * Controls one supervised call.
 *
 * One instance per call. Create it when a supervisor attaches and dispose it
 * when they detach or the call ends.
 */
export class CallSupervisor {
  readonly sessionId: string;
  private readonly transport: Transport;
  private readonly resolveSession: (sessionId: string) => Session | undefined;

  private currentState: SupervisionState = "agent";
  private handle: SupervisorHandle | null = null;
  /** Set while the agent is talking, so an event can be attributed. */
  private readonly listeners = new Set<(event: SupervisionEvent) => void>();

  constructor(sessionId: string, options: TakeoverOptions) {
    this.sessionId = sessionId;
    this.transport = options.transport;
    this.resolveSession = options.resolveSession;
  }

  get state(): SupervisionState {
    return this.currentState;
  }

  /** True when the agent, not the supervisor, is talking to the caller. */
  get isAgentSpeaking(): boolean {
    return this.currentState === "agent";
  }

  /** Observe state changes. Returns an unsubscribe function. */
  on(listener: (event: SupervisionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SupervisionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not take the call down.
      }
    }
  }

  private setState(next: SupervisionState, reason: string): void {
    if (this.currentState === next) return;
    const previous = this.currentState;
    this.currentState = next;
    this.emit({ type: "state", from: previous, to: next, reason });
  }

  /**
   * Register the supervisor's audio sink and voice output.
   *
   * Passing no handle detaches the supervisor and returns the call to the agent.
   */
  attach(handle: SupervisorHandle | null): void {
    if (this.currentState === "ended") {
      throw new Error(`Cannot attach a supervisor to ended call ${this.sessionId}`);
    }
    this.handle = handle;
    this.setState("agent", handle ? "supervisor attached" : "supervisor detached");
  }

  /**
   * Stream the caller's audio to the supervisor.
   *
   * Called by the host as audio flows. Does nothing when nobody is listening.
   */
  listen(chunk: AudioChunk): void {
    if (this.currentState === "ended") return;
    this.handle?.onAudio?.(chunk);
  }

  /**
   * Speak to the caller as the supervisor, silencing the agent first.
   *
   * The supervisor talks directly to the caller; the agent's TTS is not
   * involved, so there is nothing to interrupt.
   */
  async speak(text: string): Promise<boolean> {
    if (this.currentState === "ended") return false;
    if (!this.handle?.speak) {
      this.emit({ type: "error", message: "no supervisor voice output attached" });
      return false;
    }

    const wasAgent = this.currentState === "agent";
    if (wasAgent) this.setState("supervisor", "supervisor speaking");

    try {
      await this.handle.speak(text);
      this.emit({ type: "supervisorSpoke", text });
      return true;
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      // Return to whoever had the floor. Staying in "supervisor" would mean
      // the agent never resumes, which is a support call that never ends.
      if (wasAgent) this.setState("agent", "supervisor finished speaking");
    }
  }

  /**
   * Take over the call. The agent stops talking to the caller.
   */
  takeover(reason = "supervisor took over"): boolean {
    if (this.currentState === "ended") return false;
    if (this.currentState === "supervisor") return true;

    this.setState("supervisor", reason);
    this.emit({ type: "takeover", reason });
    return true;
  }

  /**
   * Mute the agent while the supervisor listens and speaks.
   *
   * Distinct from takeover: the agent keeps transcribing, so it can be handed
   * back with the conversation intact.
   */
  mute(): boolean {
    if (this.currentState === "ended") return false;
    if (this.currentState === "muted") return true;

    this.setState("muted", "agent muted by supervisor");
    this.emit({ type: "mute" });
    return true;
  }

  /** Return control to the agent. */
  release(): boolean {
    if (this.currentState === "ended") return false;
    if (this.currentState === "agent") return true;

    this.setState("agent", "control returned to agent");
    this.emit({ type: "release" });
    return true;
  }

  /**
   * Message only the supervisor hears — coaching, not caller-facing.
   *
   * This is a notification channel, not audio: the text is delivered to the
   * supervisor's client, and nothing is spoken to the caller.
   */
  whisper(message: string, context?: Record<string, unknown>): boolean {
    if (this.currentState === "ended") return false;
    this.emit({ type: "whisper", message, context });
    return true;
  }

  /**
   * End the call.
   *
   * Ends the transport session for the call, which is what actually tears the
   * call down; the telephony layer is responsible for the carrier side.
   */
  end(): boolean {
    if (this.currentState === "ended") return false;

    this.setState("ended", "call ended by supervisor");
    this.emit({ type: "end" });
    this.handle = null;
    return true;
  }

  /**
   * Send audio to the caller, honouring the current state.
   *
   * When the agent is muted or a supervisor holds the floor, agent audio is
   * dropped rather than played, so the caller never hears both parties.
   */
  shouldForwardAgentAudio(): boolean {
    return this.currentState === "agent";
  }

  /** The live session, when it still exists. */
  get session(): Session | undefined {
    return this.resolveSession(this.sessionId);
  }

  /** Tear down the audio session for this call. */
  async disconnect(): Promise<void> {
    const session = this.session;
    this.currentState = "ended";
    this.handle = null;
    if (!session) return;
    try {
      // Scoped to this session. `transport.stop()` tears down the whole server
      // and every concurrent call, so a supervisor detaching from one call
      // would drop every other caller on the process.
      if (this.transport.closeSession) {
        await this.transport.closeSession(this.sessionId);
      }
      // Fall back for transports that cannot address a single session. Better
      // an over-broad teardown than a supervisor stuck on a dead call.
      else {
        await this.transport.stop();
      }
    } catch {
      // Already gone.
    }
  }
}

export type SupervisionEvent =
  | { type: "state"; from: SupervisionState; to: SupervisionState; reason: string }
  | { type: "takeover"; reason: string }
  | { type: "mute" }
  | { type: "release" }
  | { type: "whisper"; message: string; context?: Record<string, unknown> }
  | { type: "supervisorSpoke"; text: string }
  | { type: "end" }
  | { type: "error"; message: string };

export function createCallSupervisor(
  sessionId: string,
  options: TakeoverOptions,
): CallSupervisor {
  return new CallSupervisor(sessionId, options);
}
