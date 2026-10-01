import type {
  JEVEngine as IJEVEngine,
  AgentAction,
  ActionMatch,
  ConversationContext,
  DecisionAnswers,
  DecisionProvider,
  EmbeddingProvider,
} from "../types.js";
import { ActionSpace } from "./action-space.js";
import { DecisionRequestError } from "./decision-provider.js";
import { isAbortError } from "../resilience/timeout.js";

/**
 * JEVEngine — The core Joint Embedding Vector engine.
 *
 * This is the brain of Felona Voice. It decides what the agent should do next
 * by encoding the conversation context into a vector and matching it against
 * the action space.
 *
 * Two modes:
 *
 * 1. **Cold Start (no predictor)**: Encodes the current context directly and
 *    matches against action embeddings via cosine similarity. Works out of the
 *    box with zero training data.
 *
 * 2. **Trained (with predictor)**: Uses a trained MLP predictor to transform
 *    the context vector into a predicted next-state vector before matching.
 *    The predictor learns conversation flow patterns from call logs.
 *
 * The engine gracefully degrades: if no predictor is loaded, it falls back
 * to cold-start mode automatically.
 */
export class JEVEngine implements IJEVEngine {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly actionSpace: ActionSpace;
  private readonly confidenceThreshold: number;
  private readonly decisionProvider: DecisionProvider | null;
  private readonly onDecisionError: "fallback" | "throw";
  private predictorModel: PredictorModel | null = null;
  private initialized = false;

  constructor(options: {
    embeddingProvider: EmbeddingProvider;
    confidenceThreshold?: number;
/** Route through a decision model instead of embedding plus cosine. */
  decisionProvider?: DecisionProvider | null;
    /** What to do when a decision call fails. Default: `"fallback"`. */
    onDecisionError?: "fallback" | "throw";
  }) {
    this.embeddingProvider = options.embeddingProvider;
    this.actionSpace = new ActionSpace(options.embeddingProvider);
    this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
    this.decisionProvider = options.decisionProvider ?? null;
    this.onDecisionError = options.onDecisionError ?? "fallback";
  }

  /**
   * Initialize the engine — embed all action descriptions into the action space.
   *
   * The action space is still built when a decision provider is configured. It
   * holds the action list the provider is asked about, and it is what
   * `getActionSpace()` and inspection read — but the embeddings it computes are
   * not what decides a turn in that mode.
   */
  async initialize(actions: AgentAction[]): Promise<void> {
    await this.actionSpace.initialize(actions);
    this.initialized = true;
  }

  /** Get embedding provider name */
  get providerName(): string {
    return this.embeddingProvider.name;
  }

  /**
   * Name of the backend that actually performs routing.
   *
   * With a decision provider configured this is that provider, not the
   * embedding provider: an operator reading a latency log needs to know which
   * backend answered, and the embedder is then only ranking candidates.
   */
  get routingBackend(): string {
    return this.decisionProvider?.name ?? this.embeddingProvider.name;
  }

  /** True when routing runs through a decision model. */
  get usesDecisionProvider(): boolean {
    return this.decisionProvider !== null;
  }

  /**
   * Load a trained predictor model.
   *
   * Not implemented in this release. Trained predictors are a planned
   * capability; rather than logging a message and silently continuing in
   * cold-start mode — which would make a misconfigured deployment look like a
   * working one — this rejects.
   */
  async loadPredictor(modelPath: string): Promise<void> {
    throw new Error(
      `Trained JEV predictors are not supported in this version (requested model: "${modelPath}"). ` +
        "Remove jev.predictorModel to use cold-start semantic routing.",
    );
  }

  /**
   * Full decision pipeline:
   * 1. Encode the conversation context
   * 2. Predict next state (or use context directly if no predictor)
   * 3. Match against action space
   *
   * With a {@link DecisionProvider} configured, step 3 asks the provider which
   * action fits instead of comparing vectors — see {@link decideWithProvider}.
   */
  async decide(context: ConversationContext): Promise<ActionMatch> {
    this.assertInitialized();

    if (this.decisionProvider) {
      return this.decideWithProvider(context, this.decisionProvider);
    }

    // Step 1: Encode context
    const contextVector = await this.encode(context);

    // Step 2: Predict (or passthrough in cold-start mode)
    const targetVector = this.predictorModel
      ? await this.predict(contextVector)
      : contextVector;

    // Step 3: Match against action space
    const match = await this.match(targetVector);

    return this.applyFallback(match);
  }

  /**
   * Route a turn by asking a decision model which action fits.
   *
   * The action space becomes one `choice` question — the actions *are* the
   * options, keyed by id and described by their own descriptions — so the model
   * sees the same routing space the embedder would, and returns a probability
   * per action rather than a similarity.
   *
   * The immediate utterance and the preceding user turns go in as the state,
   * matching the weighting the embedding path applies: the current utterance
   * leads, because a topic change should not be outvoted by earlier turns.
   */
  private async decideWithProvider(
    context: ConversationContext,
    provider: DecisionProvider,
  ): Promise<ActionMatch> {
    const actions = this.actionSpace.getActions();

    let match: ActionMatch;
    try {
      const result = await provider.decide(buildDecisionState(context), {
        route: {
          type: "choice",
          instructions:
            "Which of these is the best response to what the caller just said?",
          criteria: Object.fromEntries(
            actions.map((action) => [action.id, action.description]),
          ),
        },
      });

      match = this.toActionMatch(result.answers.route, actions);
    } catch (error) {
      // A caller cancelling is not a provider failure: the turn is being
      // abandoned on purpose, and routing it to fallback would speak a reply
      // the caller just interrupted.
      if (isAbortError(error)) throw error;

      // A contract violation is not an outage. Degrading a response that chose
      // an action we do not have into a fallback reply hides a bug behind a
      // plausible-sounding answer, so it always propagates. Only a failed call
      // is degradable.
      if (error instanceof DecisionRequestError) throw error;

      if (this.onDecisionError === "throw") throw error;

      const fallbackAction = this.actionSpace.getAction("fallback");
      if (!fallbackAction) {
        // Nothing to degrade into. Swallowing the failure here would return a
        // confident-looking match built from no evidence.
        throw error;
      }

      return {
        action: fallbackAction,
        confidence: 0,
        candidates: [],
      };
    }

    return this.applyFallback(match);
  }

  /** Build an `ActionMatch` from a single `choice` answer. */
  private toActionMatch(
    answer: DecisionAnswers | undefined,
    actions: AgentAction[],
  ): ActionMatch {
    const choice = answer?.choice;
    if (!choice) {
      throw new DecisionRequestError(
        `${this.routingBackend} answered the routing question without choosing an option.`,
        200,
      );
    }

    const probabilities = answer.probabilities ?? {};
    const candidates = actions
      .map((action) => ({
        actionId: action.id,
        score: probabilities[action.id] ?? 0,
      }))
      .sort((a, b) => b.score - a.score);

    const matched = actions.find((action) => action.id === choice);
    if (!matched) {
      throw new DecisionRequestError(
        `${this.routingBackend} chose action "${choice}", which is not registered. ` +
          "Routing to an action that does not exist is not a decision.",
        200,
      );
    }

    return {
      action: matched,
      // The reported confidence when there is one, otherwise the probability
      // mass on the chosen action. Both measure concentration, not correctness.
      confidence:
        answer.confidence ??
        (Number.isFinite(probabilities[choice]) ? probabilities[choice] : 0),
      candidates,
    };
  }

  /**
   * Route to the `fallback` action when the match is weak.
   *
   * The margin check catches a different failure from the threshold: a match
   * that clears the bar only because it is the best of a flat set, where every
   * option scored about the same.
   *
   * Note for the decision-model path: its confidence measures how concentrated
   * the distribution is, not how similar the text was, so a threshold carried
   * over from embedding routing is not automatically right. Calibrate it on
   * your own action set rather than assuming 0.35 still means the same thing.
   */
  private applyFallback(match: ActionMatch): ActionMatch {
    // Route to fallback action if:
    // 1. Top match is explicitly fallback
    // 2. Match confidence is below the threshold
    // 3. Ambiguous low-margin prediction (confidence < 0.55 with margin < 0.15)
    const fallbackAction = this.actionSpace.getAction("fallback");
    if (fallbackAction) {
      const topScore = match.candidates[0]?.score ?? 0;
      const runnerUpScore = match.candidates[1]?.score ?? 0;
      const margin = topScore - runnerUpScore;

      if (
        match.action.id === "fallback" ||
        match.confidence < this.confidenceThreshold ||
        (match.confidence < 0.55 && margin < 0.15)
      ) {
        return {
          action: fallbackAction,
          confidence: match.confidence,
          candidates: match.candidates,
        };
      }
    }

    return match;
  }

  /**
   * Encode the conversation context into a single joint embedding vector.
   *
   * Joint Embedding Fusion (JEV):
   * 1. Primary vector: Current user utterance (immediate intent, 82% weight).
   * 2. Context vector: Prior user utterances (continuity, 18% weight).
   *
   * This guarantees that new user intents (e.g. topic changes, greetings, escalations)
   * trigger immediately without being overpowered or trapped by prior conversation states.
   */
  async encode(context: ConversationContext): Promise<Float64Array> {
    if (!context.currentUtterance) {
      const fallback = context.turns.length > 0 ? context.turns[context.turns.length - 1].content : "hello";
      return this.embeddingProvider.embed(fallback);
    }

    // 1. Primary vector: immediate user utterance
    const utteranceVec = await this.embeddingProvider.embed(context.currentUtterance);

    // 2. Secondary vector: prior user requests.
    //
    // The caller's most recent user turn *is* the current utterance (it is added
    // to memory before decide()). It is already weighted at 82% above, so it is
    // dropped here — otherwise the documented 82/18 split is really 91/9 of the
    // same text plus a whisper of history.
    const priorTurns = context.turns
      .filter((t) => t.role === "user")
      .slice(-4);

    if (
      priorTurns.length > 0 &&
      priorTurns[priorTurns.length - 1].content === context.currentUtterance
    ) {
      priorTurns.pop();
    }

    if (priorTurns.length === 0) {
      return utteranceVec;
    }

    const priorText = priorTurns.map((t) => t.content).join(". ");
    const priorVec = await this.embeddingProvider.embed(priorText);

    // 3. Fused vector
    const dim = utteranceVec.length;
    const fused = new Float64Array(dim);
    const alpha = 0.82; // Immediate utterance weight
    const beta = 0.18;  // Prior context weight

    let sumSq = 0;
    for (let i = 0; i < dim; i++) {
      const val = alpha * utteranceVec[i] + beta * (priorVec[i] ?? 0);
      fused[i] = val;
      sumSq += val * val;
    }

    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < dim; i++) {
      fused[i] /= norm;
    }

    return fused;
  }

  /**
   * Predict the next-state vector from a context vector.
   *
   * Cold-start mode (no predictor): returns the input vector unchanged, so
   * matching happens directly against the action space.
   */
  async predict(contextVector: Float64Array): Promise<Float64Array> {
    if (!this.predictorModel) {
      return contextVector;
    }
    return this.predictorModel.predict(contextVector);
  }

  /**
   * Match a vector against the action space.
   */
  async match(vector: Float64Array): Promise<ActionMatch> {
    this.assertInitialized();
    return this.actionSpace.match(vector);
  }

  /** Get the action space (for testing/inspection) */
  getActionSpace(): ActionSpace {
    return this.actionSpace;
  }

  /** Check if the engine is initialized */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Check if a predictor model is loaded */
  get hasPredictor(): boolean {
    return this.predictorModel !== null;
  }

  /** Get the confidence threshold */
  get threshold(): number {
    return this.confidenceThreshold;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "JEV engine not initialized — call initialize() with actions first",
      );
    }
  }
}

/**
 * Placeholder interface for the predictor model.
 * Phase 2 will implement this with ONNX.js.
 */
interface PredictorModel {
  predict(input: Float64Array): Promise<Float64Array>;
}

/**
 * Render a conversation into the state a decision model reads.
 *
 * The immediate utterance comes last and unmarked so it reads as the live
 * question; earlier user turns give the continuity a topic change needs to be
 * judged against. Agent turns are left out — what the agent said is not
 * evidence of what the caller wants next, and including it invites the model to
 * keep answering the question that was just answered.
 */
function buildDecisionState(context: ConversationContext): string {
  const utterance = context.currentUtterance?.trim() ?? "";

  if (!utterance) {
    // No live utterance: this is the opening turn, so the system prompt is
    // what the first question is about.
    return context.systemPrompt.trim() || "The caller has just connected.";
  }

  const prior = context.turns
    .filter((turn) => turn.role === "user" && turn.content.trim() !== utterance)
    .slice(-4)
    .map((turn) => turn.content.trim())
    .filter((content) => content !== "");

  if (prior.length === 0) return utterance;

  return `Earlier in this call the caller said:\n${prior
    .map((content) => `- ${content}`)
    .join("\n")}\n\nThe caller just said: ${utterance}`;
}

/**
 * Create a JEV engine with the given embedding provider.
 */
export function createJEVEngine(options: {
  embeddingProvider: EmbeddingProvider;
  confidenceThreshold?: number;
  decisionProvider?: DecisionProvider | null;
  onDecisionError?: "fallback" | "throw";
}): JEVEngine {
  return new JEVEngine(options);
}
