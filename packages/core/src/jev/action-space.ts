import type {
  AgentAction,
  ActionMatch,
  EmbeddingProvider,
} from "../types.js";

/**
 * ActionSpace — Manages the set of actions available to the agent and
 * performs embedding-based matching.
 *
 * At initialization, each action's description is embedded. During inference,
 * a predicted/context vector is compared against all action embeddings via
 * cosine similarity to find the best match.
 */
export class ActionSpace {
  private actions: AgentAction[] = [];
  private embeddings: Map<string, Float64Array> = new Map();
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(embeddingProvider: EmbeddingProvider) {
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Initialize the action space — embeds all action descriptions.
   * Must be called before any matching.
   *
   * Action IDs must be unique: embeddings are keyed by ID, so a duplicate would
   * silently overwrite one entry and leave the corresponding action permanently
   * unreachable (it would still be scored, against the other action's vector).
   */
  async initialize(actions: AgentAction[]): Promise<void> {
    if (actions.length === 0) {
      throw new Error("ActionSpace requires at least one action");
    }

    const seen = new Set<string>();
    for (const action of actions) {
      if (!action.id || typeof action.id !== "string") {
        throw new Error("Every action requires a non-empty string id");
      }
      if (seen.has(action.id)) {
        throw new Error(
          `Duplicate action id "${action.id}". Action ids must be unique — ` +
            "duplicated ids collapse into a single embedding and one action " +
            "becomes unroutable.",
        );
      }
      if (!action.description || !action.description.trim()) {
        throw new Error(
          `Action "${action.id}" requires a non-empty description — it is what JEV embeds to route to this action.`,
        );
      }
      seen.add(action.id);
    }

    this.actions = actions;
    // Drop embeddings for actions that no longer exist, so re-initializing
    // with a smaller action set does not leave stale vectors behind.
    this.embeddings.clear();

    // Batch embed all action descriptions
    const descriptions = actions.map((a) => a.description);
    const vectors = await this.embeddingProvider.embedBatch(descriptions);

    for (let i = 0; i < actions.length; i++) {
      const vector = vectors[i];
      if (!vector) {
        throw new Error(
          `Embedding provider "${this.embeddingProvider.name}" returned no vector for action "${actions[i].id}"`,
        );
      }
      this.embeddings.set(actions[i].id, vector);
    }
  }

  /**
   * Find the closest action to the given vector using cosine similarity.
   */
  match(vector: Float64Array): ActionMatch {
    if (this.actions.length === 0) {
      throw new Error("ActionSpace not initialized — call initialize() first");
    }

    const candidates: Array<{ actionId: string; score: number }> = [];

    for (const action of this.actions) {
      const actionEmbedding = this.embeddings.get(action.id);
      if (!actionEmbedding) continue;

      const score = cosineSimilarity(vector, actionEmbedding);
      candidates.push({ actionId: action.id, score });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const bestMatch = candidates[0];
    const matchedAction = this.actions.find(
      (a) => a.id === bestMatch.actionId,
    )!;

    return {
      action: matchedAction,
      confidence: bestMatch.score,
      candidates,
    };
  }

  /** Get an action by ID */
  getAction(id: string): AgentAction | undefined {
    return this.actions.find((a) => a.id === id);
  }

  /** Get the embedding for an action */
  getEmbedding(actionId: string): Float64Array | undefined {
    return this.embeddings.get(actionId);
  }

  /** Get all actions */
  getActions(): AgentAction[] {
    return [...this.actions];
  }

  /** Number of actions in the space */
  get size(): number {
    return this.actions.length;
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
