import type {
  JEVEngine as IJEVEngine,
  AgentAction,
  ActionMatch,
  ConversationContext,
  EmbeddingProvider,
} from "../types.js";
import { ActionSpace } from "./action-space.js";

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
  private predictorModel: PredictorModel | null = null;
  private initialized = false;

  constructor(options: {
    embeddingProvider: EmbeddingProvider;
    confidenceThreshold?: number;
  }) {
    this.embeddingProvider = options.embeddingProvider;
    this.actionSpace = new ActionSpace(options.embeddingProvider);
    this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
  }

  /**
   * Initialize the engine — embed all action descriptions into the action space.
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
   */
  async decide(context: ConversationContext): Promise<ActionMatch> {
    this.assertInitialized();

    // Step 1: Encode context
    const contextVector = await this.encode(context);

    // Step 2: Predict (or passthrough in cold-start mode)
    const targetVector = this.predictorModel
      ? await this.predict(contextVector)
      : contextVector;

    // Step 3: Match against action space
    const match = await this.match(targetVector);

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
 * Create a JEV engine with the given embedding provider.
 */
export function createJEVEngine(options: {
  embeddingProvider: EmbeddingProvider;
  confidenceThreshold?: number;
}): JEVEngine {
  return new JEVEngine(options);
}
