/**
 * Document chunking for retrieval.
 *
 * Chunk boundaries decide retrieval quality more than the similarity metric
 * does. Splitting mid-sentence embeds half a thought and makes it
 * unmatchable; splitting too coarsely puts five answers in one vector and the
 * best-matching one still loses to the loudest topic in the chunk.
 *
 * The strategy here is boundary-aware, target-sized, and overlapping:
 *   1. Split on paragraph breaks where possible.
 *   2. Split over-long paragraphs on sentence boundaries.
 *   3. Hard-split only what is still too long, on word boundaries.
 *   4. Merge undersized neighbours up to the target so a chunk carries a
 *      complete thought.
 *   5. Repeat the tail of each chunk into the next, so a fact spanning a
 *      boundary is retrievable from either side. A chunk with overlap can
 *      therefore exceed `maxChars` by up to `overlapChars`.
 */

export interface ChunkOptions {
  /** Target characters per chunk. Default: 500 */
  targetChars?: number;
  /** Minimum characters; smaller fragments are merged into a neighbour. Default: 120 */
  minChars?: number;
  /** Maximum characters; longer content is split. Default: 1200 */
  maxChars?: number;
  /** Characters of trailing context repeated into the next chunk. Default: 100 */
  overlapChars?: number;
}

/** A retrievable unit of text. */
export interface Chunk {
  /** Stable id, derived from the source and position. */
  id: string;
  /** Chunk text, trimmed. */
  text: string;
  /** Index within its source document. */
  index: number;
}

/** Split text into sentences without breaking on common abbreviations. */
export function splitSentences(text: string): string[] {
  const protectedText = text
    // Guard the common cases that would otherwise split mid-token.
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|No|Nos)\./g, "$1<DOT>")
    .replace(/\b([A-Z])\./g, "$1<DOT>");

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((sentence) => sentence.replace(/<DOT>/g, ".").trim())
    .filter(Boolean);
}

/** Hard-wrap over-long text on word boundaries. */
function wrapWords(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    // A single word longer than the limit still has to go somewhere.
    if (word.length > maxChars) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) {
        out.push(word.slice(i, i + maxChars));
      }
      continue;
    }

    if (current.length + word.length + 1 > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }

  if (current) out.push(current);
  return out;
}

/**
 * Break text into boundary-aligned pieces no longer than `maxChars`.
 * Paragraphs are preserved where they fit; otherwise sentences are used.
 */
function splitIntoPieces(text: string, maxChars: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pieces: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      pieces.push(paragraph);
      continue;
    }

    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length <= maxChars) {
        pieces.push(sentence);
        continue;
      }
      pieces.push(...wrapWords(sentence, maxChars));
    }
  }

  return pieces;
}

/**
 * Take the trailing `overlapChars` of `text`, snapped to a word boundary.
 *
 * Snapping avoids starting a chunk mid-word, which is exactly the kind of
 * garbage that embeds badly.
 */
function tailOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return text;

  const tail = text.slice(-overlapChars);
  const firstSpace = tail.indexOf(" ");
  if (firstSpace === -1 || firstSpace > overlapChars * 0.5) return tail;

  return tail.slice(firstSpace + 1);
}

/**
 * Chunk a document into overlapping, boundary-aligned pieces.
 */
export function chunkText(
  text: string,
  options?: ChunkOptions,
): Chunk[] {
  const targetChars = options?.targetChars ?? 500;
  const minChars = options?.minChars ?? 120;
  const maxChars = options?.maxChars ?? 1200;
  const overlapChars = options?.overlapChars ?? 100;

  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const pieces = splitIntoPieces(cleaned, maxChars);

  // Group pieces into chunks near the target size.
  const groups: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > targetChars) {
      groups.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) groups.push(current);

  // Merge undersized chunks forward so a one-line chunk does not become its own
  // embedding, which is mostly punctuation to the similarity metric.
  const merged: string[] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];

    if (previous !== undefined && previous.length < minChars) {
      merged[merged.length - 1] = `${previous}\n\n${group}`;
    } else {
      merged.push(group);
    }
  }

  return merged.map((body, index, all) => {
    let text = body;

    // Overlap: carry the tail of the previous chunk forward, so a fact that
    // straddles a boundary is retrievable from either side.
    if (index > 0 && overlapChars > 0) {
      const overlap = tailOverlap(all[index - 1], overlapChars);
      // Skip when the neighbour was absorbed by merging and already contains it.
      if (overlap && !text.startsWith(overlap)) {
        text = `${overlap}\n\n${text}`;
      }
    }

    return {
      id: `chunk-${index}`,
      text: text.trim(),
      index,
    };
  });
}

/**
 * Chunk text, prefixing ids with a source identifier so chunks from different
 * documents never collide.
 */
export function chunkDocument(
  text: string,
  sourceId: string,
  options?: ChunkOptions,
): Array<Chunk & { sourceId: string }> {
  return chunkText(text, options).map((chunk) => ({
    ...chunk,
    id: `${sourceId}::${chunk.id}`,
    sourceId,
  }));
}
