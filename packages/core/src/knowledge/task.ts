import type { ActionContext, AgentAction } from "../types.js";
import type {
  KnowledgeChunk,
  KnowledgeSearchOptions,
  KnowledgeSearcher,
} from "./kb.js";

/**
 * A knowledge-base action.
 *
 * Retrieval only: the action returns the passages and a short framing line, and
 * the handler decides how to phrase the answer. No model is involved, so the
 * reply is exactly what the handler returns.
 */

export interface KnowledgeTaskOptions {
  /**
   * The knowledge base, or anything exposing `search()`. A searcher is accepted
   * so the task can be declared before the agent that owns the base exists.
   */
  knowledge: KnowledgeSearcher;
  /** Action id. Default: `knowledge`. */
  id?: string;
  /** Description JEV embeds to route here. Auto-generated if omitted. */
  description?: string;
  /**
   * Compose the spoken answer.
   *
   * Receives the retrieved passages (possibly empty) and must return the text
   * to speak. Required — the framework will not invent an answer.
   */
  answer: (results: KnowledgeChunk[], ctx: ActionContext) => string | Promise<string>;
  /** Retrieval options for this action. */
  search?: KnowledgeSearchOptions;
  /**
   * Slot to store the passages under, so later turns can refer back to them
   * without re-retrieving. Omit to discard after the turn.
   */
  storeUnder?: string;
}

export function createKnowledgeTask(options: KnowledgeTaskOptions): AgentAction {
  if (!options?.knowledge) {
    throw new Error("createKnowledgeTask requires a knowledge base");
  }
  if (typeof options.answer !== "function") {
    throw new Error(
      "createKnowledgeTask requires an `answer` function — the framework does not " +
        "generate answers from retrieved text on your behalf",
    );
  }

  const id = options.id ?? "knowledge";
  const description =
    options.description ??
    "Answer a question using the company knowledge base, policies, documentation " +
      "or FAQ. Use whenever the caller asks something factual about the business, " +
      "its products, shipping, returns, pricing or support hours.";

  return {
    id,
    description,
    handler: async (ctx: ActionContext) => {
      const query = ctx.conversation.currentUtterance;
      const results = await options.knowledge.search(query, options.search);

      if (options.storeUnder) {
        ctx.memory.setSlot(options.storeUnder, results);
      }

      return options.answer(results, ctx);
    },
  };
}

/** Default answer composition: read the best passage, or admit ignorance. */
export function defaultKnowledgeAnswer(
  results: KnowledgeChunk[],
  options: { notFound?: string } = {},
): string {
  if (results.length === 0) {
    return options.notFound ?? "I don't have that information in front of me right now.";
  }
  // The passage is reference material written for reading, not for speaking, so
  // the caller is told where it came from rather than having it read verbatim.
  const best = results[0];
  return `Here's what I found on that: ${best.text}`;
}
