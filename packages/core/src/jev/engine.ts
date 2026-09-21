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
    this.confidenceThreshold = options.confidenceThreshold ?? 0.3;
  }

  /**
   * Initialize the engine — embed all action descriptions into the action space.
   */
  async initialize(actions: AgentAction[]): Promise<void> {
    await this.actionSpace.initialize(actions);
    this.initialized = true;
  }

  /**
   * Load a trained predictor model.
   * In Phase 1, this is a no-op — we run in cold-start mode.
   * Phase 2 will add ONNX.js predictor loading.
   */
  async loadPredictor(modelPath: string): Promise<void> {
    // Phase 2: Load ONNX model here
    // this.predictorModel = await loadONNXModel(modelPath);
    console.log(
      `[JEV] Predictor model loading not yet implemented. Path: ${modelPath}`,
    );
    console.log("[JEV] Running in cold-start mode (direct embedding similarity)");
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

    return match;
  }

  /**
   * Encode the conversation context into a single embedding vector.
   *
   * The context string is constructed from:
   * - System prompt (agent personality)
   * - Recent conversation history
   * - Current user utterance
   * - Extracted slots
   *
   * This is the input to the predictor network.
   */
  async encode(context: ConversationContext): Promise<Float64Array> {
    const contextString = this.buildContextString(context);
    return this.embeddingProvider.embed(contextString);
  }

  /**
   * Predict the next-state vector from a context vector.
   *
   * In cold-start mode (no predictor), returns the input vector unchanged.
   * With a trained predictor, transforms the context vector to predict
   * what the next conversation state should look like.
   */
  async predict(contextVector: Float64Array): Promise<Float64Array> {
    if (!this.predictorModel) {
      // Cold-start mode: direct passthrough
      return contextVector;
    }

    // Phase 2: Run ONNX predictor
    // return this.predictorModel.predict(contextVector);
    return contextVector;
  }

  /**
   * Match a vector against the action space.
   */
  async match(vector: Float64Array): Promise<ActionMatch> {
    this.assertInitialized();
    return this.actionSpace.match(vector);
  }

  /**
   * Build a text string from the conversation context for embedding.
   *
   * Design: We want the embedding to capture:
   * - What kind of agent this is (system prompt excerpt)
   * - What has been discussed (recent turns)
   * - What the user just said (current utterance)
   * - What we know so far (slots)
   */
  private buildContextString(context: ConversationContext): string {
    const parts: string[] = [];

    // Agent personality (truncated to keep embedding focused)
    if (context.systemPrompt) {
      const truncated = context.systemPrompt.slice(0, 200);
      parts.push(`Agent: ${truncated}`);
    }

    // Recent conversation history (last 5 turns for embedding focus)
    const recentTurns = context.turns.slice(-5);
    if (recentTurns.length > 0) {
      const history = recentTurns
        .map(
          (t) =>
            `${t.role === "user" ? "User" : "Agent"}: ${t.content}`,
        )
        .join("\n");
      parts.push(`History:\n${history}`);
    }

    // Current user utterance (most important for decision)
    if (context.currentUtterance) {
      parts.push(`Current user message: ${context.currentUtterance}`);
    }

    // Extracted slots
    const slotEntries = Object.entries(context.slots);
    if (slotEntries.length > 0) {
      const slotsStr = slotEntries
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      parts.push(`Known information: ${slotsStr}`);
    }

    return parts.join("\n\n");
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
