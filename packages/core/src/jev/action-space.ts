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
   * Embeds all action descriptions and swaps them in atomically.
   *
   * The new vectors are built into a local map and published in one assignment.
   * Swapping `actions` first and awaiting the embed in between left a window
   * where `match()` iterated the new actions against the old (or empty)
   * embedding map, skipped every action, and dereferenced an undefined best
   * match — a TypeError on a live call.
   */
  async initialize(actions: AgentAction[]): Promise<void> {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error(
        "ActionSpace.initialize requires at least one action — JEV routes every turn, so an empty action set cannot answer a call.",
      );
    }

    const seen = new Set<string>();
    for (const action of actions) {
      if (!action.id || action.id.trim() === "") {
        throw new Error(
          "Every action needs a non-empty id — duplicate or blank ids make routing ambiguous.",
        );
      }
      if (seen.has(action.id)) {
        throw new Error(
          `Duplicate action id "${action.id}". Action ids must be unique or JEV cannot route between them.`,
        );
      }
      if (!action.description || action.description.trim() === "") {
        throw new Error(
          `Action "${action.id}" requires a non-empty description — it is what JEV embeds to route to this action.`,
        );
      }
      seen.add(action.id);
    }

    // Embed into a local map first; nothing observable changes until it is
    // ready, so a concurrent match() keeps using the previous consistent state.
    const descriptions = actions.map((a) => a.description);
    const vectors = await this.embeddingProvider.embedBatch(descriptions);

    const nextEmbeddings = new Map<string, Float64Array>();
    for (let i = 0; i < actions.length; i++) {
      const vector = vectors[i];
      if (!vector) {
        throw new Error(
          `Embedding provider "${this.embeddingProvider.name}" returned no vector for action "${actions[i].id}"`,
        );
      }
      nextEmbeddings.set(actions[i].id, vector);
    }

    // Publish atomically.
    this.embeddings = nextEmbeddings;
    this.actions = actions;
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

    // Guard rather than dereference blindly: an action with no embedding (a
    // provider that returned nothing for it) leaves the candidate list short,
    // and a TypeError here takes down a live call.
    const bestMatch = candidates[0];
    if (!bestMatch) {
      throw new Error(
        `No action could be scored: ${this.actions.length} action(s) are registered but none has an embedding. ` +
          "Re-initialize the action space before routing.",
      );
    }
    const matchedAction = this.actions.find(
      (a) => a.id === bestMatch.actionId,
    );
    if (!matchedAction) {
      throw new Error(
        `Best match "${bestMatch.actionId}" is not a registered action — the action space is inconsistent.`,
      );
    }

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
