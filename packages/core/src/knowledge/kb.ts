import { cosineSimilarity } from "../jev/action-space.js";
import { chunkDocument, type ChunkOptions } from "./chunk.js";
import type { EmbeddingProvider } from "../types.js";

/**
 * Retrieval over the agent's own documentation.
 *
 * Deliberately *retrieval only*. The knowledge base finds passages; it does not
 * write the reply. Composing an answer from retrieved text is an action
 * handler's job, which keeps the framework's "no model in the loop" property
 * and leaves the phrasing under the developer's control.
 *
 * It reuses the same `EmbeddingProvider` as JEV, so an agent already paying for
 * embeddings to route pays nothing extra to retrieve, and a custom provider
 * improves both at once.
 */

export interface KnowledgeDocument {
  /** Stable identifier, used in citations and removal. */
  id: string;
  text: string;
  /** Free-form labels for filtering, e.g. { topic: "returns" }. */
  metadata?: Record<string, string | number | boolean>;
}

export interface KnowledgeChunk {
  id: string;
  text: string;
  sourceId: string;
  sourceText: string;
  index: number;
  score: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface KnowledgeSearchOptions {
  /** Maximum passages to return. Default: 3 */
  topK?: number;
  /**
   * Minimum cosine similarity for a passage to be returned. Default: 0.2.
   *
   * Without a floor, a query unrelated to the knowledge base still returns the
   * least-bad match, and the agent confidently answers from it.
   */
  minScore?: number;
  /** Only consider documents carrying all of these metadata entries. */
  filter?: Record<string, string | number | boolean>;
}

export interface KnowledgeBaseOptions {
  embeddingProvider: EmbeddingProvider;
  /** Chunking strategy. */
  chunk?: ChunkOptions;
  /** Default `topK`. Default: 3 */
  topK?: number;
  /** Default `minScore`. Default: 0.2 */
  minScore?: number;
}

interface IndexedChunk extends Omit<KnowledgeChunk, "score"> {
  embedding: Float64Array;
}

/**
 * The narrow slice of a knowledge base that consumers need.
 *
 * Lets a task be constructed before the knowledge base exists — the builder
 * resolves it after the agent is built — without handing out a half-initialized
 * object or depending on the whole class.
 */
export interface KnowledgeSearcher {
  search(
    query: string,
    options?: { topK?: number; minScore?: number },
  ): Promise<KnowledgeChunk[]>;
}

export class KnowledgeBase implements KnowledgeSearcher {
  readonly name: string;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly chunkOptions: ChunkOptions;
  private readonly defaultTopK: number;
  private readonly defaultMinScore: number;
  private chunks: IndexedChunk[] = [];
  private readonly sources = new Map<string, KnowledgeDocument>();
  /** Cached query embeddings, so repeated phrasing is not re-embedded. */
  private readonly queryCache = new Map<string, Float64Array>();
  private static readonly QUERY_CACHE_LIMIT = 128;

  constructor(options: KnowledgeBaseOptions) {
    if (!options?.embeddingProvider) {
      throw new Error("KnowledgeBase requires an embeddingProvider");
    }
    this.embeddingProvider = options.embeddingProvider;
    this.chunkOptions = options.chunk ?? {};
    this.defaultTopK = options.topK ?? 3;
    this.defaultMinScore = options.minScore ?? 0.2;
    this.name = `knowledge(${this.embeddingProvider.name})`;
  }

  /** Number of indexed chunks. */
  get size(): number {
    return this.chunks.length;
  }

  /** Number of source documents. */
  get documentCount(): number {
    return this.sources.size;
  }

  /** Ids of every indexed document. */
  listDocuments(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Add or replace a document, re-indexing only that document.
   *
   * Replacing rather than appending matters: a stale duplicate of an updated
   * policy is the most common way a knowledge base starts contradicting itself.
   */
  async add(document: KnowledgeDocument): Promise<number> {
    if (!document.id) {
      throw new Error("Knowledge document requires an id");
    }
    if (!document.text || !document.text.trim()) {
      throw new Error(`Knowledge document "${document.id}" has no text`);
    }

    this.remove(document.id);
    this.sources.set(document.id, document);

    const pieces = chunkDocument(document.text, document.id, this.chunkOptions);
    if (pieces.length === 0) return 0;

    const vectors = await this.embeddingProvider.embedBatch(
      pieces.map((piece) => piece.text),
    );

    for (let i = 0; i < pieces.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;

      this.chunks.push({
        id: pieces[i].id,
        text: pieces[i].text,
        sourceId: document.id,
        sourceText: document.text,
        index: pieces[i].index,
        metadata: document.metadata,
        embedding: vector,
      });
    }

    return pieces.length;
  }

  /** Add several documents, embedding them in one batch. */
  async addAll(documents: KnowledgeDocument[]): Promise<number> {
    let added = 0;
    for (const document of documents) {
      added += await this.add(document);
    }
    return added;
  }

  /** Remove a document and all of its chunks. */
  remove(id: string): boolean {
    this.sources.delete(id);
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((chunk) => chunk.sourceId !== id);
    return this.chunks.length < before;
  }

  /** Drop everything. */
  clear(): void {
    this.chunks = [];
    this.sources.clear();
    this.queryCache.clear();
  }

  private matchesFilter(
    metadata: Record<string, string | number | boolean> | undefined,
    filter?: Record<string, string | number | boolean>,
  ): boolean {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
      if (metadata?.[key] !== value) return false;
    }
    return true;
  }

  /**
   * Retrieve the passages most relevant to a query.
   *
   * Returns an empty array rather than a weak match when nothing clears
   * `minScore`, so the agent can say "I don't know" instead of answering from
   * the least-irrelevant paragraph it owns.
   */
  async search(
    query: string,
    options?: KnowledgeSearchOptions,
  ): Promise<KnowledgeChunk[]> {
    const trimmed = query.trim();
    if (!trimmed || this.chunks.length === 0) return [];

    const topK = options?.topK ?? this.defaultTopK;
    const minScore = options?.minScore ?? this.defaultMinScore;
    if (topK <= 0) return [];

    const queryVector = await this.embedQuery(trimmed);

    const scored: KnowledgeChunk[] = [];
    for (const chunk of this.chunks) {
      if (!this.matchesFilter(chunk.metadata, options?.filter)) continue;

      const score = cosineSimilarity(queryVector, chunk.embedding);
      if (score < minScore) continue;

      scored.push({
        id: chunk.id,
        text: chunk.text,
        sourceId: chunk.sourceId,
        sourceText: chunk.sourceText,
        index: chunk.index,
        score,
        metadata: chunk.metadata,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Format retrieved passages for an action handler to read from.
   *
   * Includes the source id so a reply can cite where the answer came from,
   * which is what makes a retrieval-based answer auditable.
   */
  static formatContext(results: KnowledgeChunk[]): string {
    if (results.length === 0) return "";
    return results
      .map((r, i) => `[${i + 1}] (${r.sourceId}, score ${r.score.toFixed(2)})\n${r.text}`)
      .join("\n\n");
  }

  private async embedQuery(query: string): Promise<Float64Array> {
    const cached = this.queryCache.get(query);
    if (cached) return cached;

    const vector = await this.embeddingProvider.embed(query);

    // Bounded cache: a long-running call centre sees unbounded distinct
    // queries, and an unbounded map is a slow leak.
    if (this.queryCache.size >= KnowledgeBase.QUERY_CACHE_LIMIT) {
      const oldest = this.queryCache.keys().next();
      if (!oldest.done) this.queryCache.delete(oldest.value);
    }
    this.queryCache.set(query, vector);
    return vector;
  }
}

export function createKnowledgeBase(options: KnowledgeBaseOptions): KnowledgeBase {
  return new KnowledgeBase(options);
}
