/**
 * Answering-machine detection.
 *
 * An outbound call that reaches voicemail gets billed, ties up a concurrency
 * slot for the length of the greeting plus whatever the detection takes, and
 * produces a turn that routes into the agent as if a human had spoken. On a
 * campaign that is the difference between a 4% and a 40% answer rate.
 *
 * Detection runs on the transcript rather than the audio, so it works with any
 * STT provider and costs nothing extra. The tradeoff is real: a voicemail
 * greeting has to reach the recogniser before it can be judged, so this is a
 * "stop the call" mechanism rather than a "route to the right person" one.
 */

/** What the detector concluded. */
export type VoicemailVerdict =
  /** A human answered. */
  | "human"
  /** An answering machine or voicemail box. */
  | "voicemail"
  /** Not enough signal yet. */
  | "unknown";

/** Options for {@link detectVoicemail}. */
export interface VoicemailOptions {
  /**
   * Skip detection for this many seconds of conversation.
   *
   * Greetings are ambiguous — "Hi, you've reached..." can be a person picking
   * up mid-sentence — so waiting briefly avoids hanging up on a human who
   * answers late. Default: 6s.
   */
  graceMs?: number;
  /**
   * Stop treating the call as human once this many consecutive machine-like
   * turns are seen. Default: 2.
   */
  threshold?: number;
  /** Additional phrases that indicate a machine, matched case-insensitively. */
  extraPhrases?: string[];
  /** Override the decision, e.g. from a carrier API. */
  override?: (transcript: string) => VoicemailVerdict | undefined;
}

/** Tracks whether the far end is a machine. */
export class VoicemailDetector {
  private readonly options: Required<Omit<VoicemailOptions, "override">> &
    Pick<VoicemailOptions, "override">;
  private transcript = "";
  private elapsedMs = 0;
  private machineSignals = 0;
  private verdict: VoicemailVerdict = "unknown";

  constructor(options?: VoicemailOptions) {
    this.options = {
      graceMs: options?.graceMs ?? 6_000,
      threshold: options?.threshold ?? 2,
      extraPhrases: options?.extraPhrases ?? [],
      override: options?.override,
    };
  }

  /** The current verdict. */
  getVerdict(): VoicemailVerdict {
    return this.verdict;
  }

  /** True once the call should be treated as a machine. */
  get isVoicemail(): boolean {
    return this.verdict === "voicemail";
  }

  /**
   * Feeds a turn of transcript.
   *
   * Returns the current verdict so a caller can branch without polling. Once
   * the verdict is settled it stops re-evaluating: a human who says "leave a
   * message after the beep" mid-call should not flip an answered call to
   * voicemail.
   */
  addTranscript(text: string, elapsedMs: number): VoicemailVerdict {
    this.elapsedMs = elapsedMs;
    this.transcript += `${text} `;

    const override = this.options.override?.(text);
    if (override) {
      this.verdict = override;
      return this.verdict;
    }

    if (this.verdict !== "unknown") return this.verdict;

    if (matchesMachinePhrase(this.transcript, this.options.extraPhrases)) {
      this.machineSignals++;
    } else if (looksLikeHuman(this.transcript)) {
      this.machineSignals = 0;
    }

    // The grace window exists because a machine greeting and a human answering
    // late sound identical for the first second or two.
    if (
      this.elapsedMs >= this.options.graceMs &&
      this.machineSignals >= this.options.threshold
    ) {
      this.verdict = "voicemail";
    }
    return this.verdict;
  }

  /** The accumulated transcript, for the operator's records. */
  getTranscript(): string {
    return this.transcript.trim();
  }
}

/**
 * Phrases that appear in answering-machine greetings.
 *
 * Deliberately phrase-based rather than a model: this has to be auditable, and
 * a false positive ends a real person's call.
 */
const MACHINE_PHRASES = [
  "leave a message",
  "after the beep",
  "after the tone",
  "you have reached",
  "you've reached",
  "is not available",
  "is unavailable",
  "please leave a message",
  "mailbox",
  "answering machine",
  "voicemail",
  "voice mail",
  "this phone number",
  "is currently unavailable",
  "cannot be reached",
  "may not be reached",
  "please leave a message after",
  "for urgent matters",
  "someone will get back",
  "we will get back to you",
  "thanks for calling",
  "have you reached the correct",
];

/** True when the transcript contains an answering-machine phrase. */
export function matchesMachinePhrase(
  transcript: string,
  extraPhrases: string[] = [],
): boolean {
  const haystack = transcript.toLowerCase();
  return [...MACHINE_PHRASES, ...extraPhrases].some((p) =>
    haystack.includes(p.toLowerCase()),
  );
}

/** Phrases that indicate a person, clearing accumulated machine signals. */
const HUMAN_PHRASES = [
  "hello",
  "hi there",
  "can i help",
  "how can i help",
  "good morning",
  "good afternoon",
  "this is",
  "speaking",
  "yeah",
  "yes",
  "what",
  "who is this",
  "one moment",
  "hold on",
];

/** True when the transcript looks like a person speaking. */
export function looksLikeHuman(transcript: string): boolean {
  const haystack = transcript.toLowerCase().trim();
  if (haystack.length < 4) return false;
  return HUMAN_PHRASES.some((p) => haystack.includes(p));
}

/** Factory for {@link VoicemailDetector}. */
export function createVoicemailDetector(options?: VoicemailOptions): VoicemailDetector {
  return new VoicemailDetector(options);
}
