import type { EmbeddingProvider } from "../types.js";

/**
 * FastSemanticEmbeddingProvider
 *
 * A deterministic, dependency-free semantic vector generator (128-d) for
 * real-time JEV action-space routing. No API key, no model download.
 *
 * The vector is the weighted sum of three independently L2-normalized signals:
 *
 * | Signal        | Weight | Purpose                                              |
 * |---------------|--------|------------------------------------------------------|
 * | Keyword       | 0.62   | Domain anchors — the actual routing signal             |
 * | Char 3-grams  | 0.23   | Morphological variants ("track"/"tracking"/"tracked")   |
 * | Word hashes   | 0.15   | Disambiguation of otherwise unknown words              |
 *
 * Normalizing each signal *before* mixing is what keeps long utterances from
 * drowning the keywords: accumulating raw gram counts made a 15-word sentence
 * contribute ~30 units of hashed noise against ~3.5 units of keyword signal,
 * so routing degraded exactly as user speech got more natural.
 */

/** Very common English function words — no routing signal, only noise. */
const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as",
  "at", "be", "because", "been", "before", "being", "but", "by", "can", "could",
  "did", "do", "does", "doing", "for", "from", "had", "has", "have", "he",
  "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "me", "more", "most", "my", "no", "nor", "not", "of",
  "off", "on", "once", "only", "or", "other", "our", "out", "over", "own",
  "same", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "would", "you", "your",
]);

const KEYWORD_WEIGHT = 0.62;
const GRAM_WEIGHT = 0.23;
const WORD_WEIGHT = 0.15;

/**
 * Crude but effective suffix stripping.
 *
 * Only used as a *fallback*: the raw token is looked up first, so inflected
 * forms that are themselves anchors ("shattered") still match.
 */
function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ["ingly", "edly", "ing", "ies", "ied", "ed", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      let base = token.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") base += "y";
      // Undo doubled consonants: "shipp" -> "ship"
      if (base.length > 3 && base[base.length - 1] === base[base.length - 2]) {
        base = base.slice(0, -1);
      }
      return base;
    }
  }
  return token;
}

/** Deterministic non-negative bucket index for a fixed vector width. */
function hashBucket(value: string, dimensions: number): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0) % dimensions;
}

/** In-place L2 normalization. A zero vector is left alone. */
function normalize(vec: Float64Array): void {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
}

export class FastSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fast-semantic";
  readonly dimensions = 128;

  private readonly semanticKeywords: Record<string, number[]> = {
    // Greetings & Core
    hello: [0, 1, 2],
    hi: [0, 1, 2],
    hey: [0, 1],
    greet: [0, 1, 2],
    greeting: [0, 1, 2],
    greetings: [0, 1, 2],
    morning: [1, 2],
    evening: [1, 2],
    welcome: [0, 3],
    assist: [2, 3, 4],
    help: [3, 4, 5],
    who: [5, 6],
    intro: [5, 6],
    pitch: [5, 7],

    // Support & Orders
    order: [10, 11, 12],
    package: [10, 11, 13],
    tracking: [11, 12, 14],
    track: [11, 12, 14],
    shipment: [10, 12, 14],
    delivery: [11, 13, 14],
    arrive: [12, 13],
    status: [10, 14],
    where: [11, 14],
    courier: [10, 12, 13],

    // Troubleshooting & Technical
    troubleshoot: [20, 21, 23],
    device: [21, 22, 24],
    light: [22, 23],
    blinking: [22, 23, 25],
    power: [21, 24, 25],
    wifi: [23, 24, 26],
    glitch: [20, 22, 26],
    reset: [24, 25, 27],
    restart: [24, 25, 27],
    reboot: [24, 25, 27],
    fail: [20, 21, 27],
    unplug: [21, 24, 26],
    unplugged: [21, 24, 26],

    // Refund & Billing
    refund: [30, 31, 32],
    return: [30, 31, 33],
    returns: [30, 31, 33],
    money: [31, 32, 34],
    back: [31, 32],
    bill: [32, 33, 35],
    billing: [32, 33, 35],
    charge: [32, 34, 35],
    cancel: [30, 33, 36],
    dispute: [31, 35, 36],
    label: [33, 36],
    damaged: [30, 31, 34],
    damage: [30, 31, 34],
    shattered: [30, 31, 34],
    defective: [30, 32, 34],
    faulty: [30, 32, 34],
    compensation: [31, 32, 35],

    // Escalation & Management
    manager: [40, 41, 42],
    supervisor: [40, 41, 43],
    human: [41, 42, 44],
    someone: [41, 42, 44],
    somebody: [41, 42, 44],
    anybody: [41, 42, 44],
    operator: [40, 41, 45],
    agent: [40, 41, 45],
    person: [41, 42, 44],
    unacceptable: [42, 43, 45],
    angry: [42, 43, 46],
    frustrated: [42, 43, 46],
    talk: [40, 44],
    speak: [40, 44],
    transfer: [40, 41, 45],
    escalate: [40, 43, 45],
    escalation: [40, 43, 45],
    representative: [41, 42, 45],
    demand: [42, 43, 46],

    // Closing & Gratitude
    thanks: [50, 51, 52],
    thank: [50, 51, 52],
    bye: [51, 52, 53],
    goodbye: [51, 52, 53],
    resolved: [50, 53, 54],
    clear: [50, 54],
    great: [50, 52],
    wonderful: [50, 52],

    // Sales & SDR
    pricing: [60, 61, 62],
    price: [60, 61, 62],
    cost: [60, 61, 63],
    budget: [61, 62, 64],
    expensive: [61, 63, 64],
    demo: [65, 66, 67],
    meeting: [65, 66, 68],
    calendar: [66, 67, 68],
    schedule: [65, 67, 69],
    telephony: [70, 71, 72],
    twilio: [70, 71, 73],
    stack: [71, 72, 74],
    latency: [72, 73, 75],
    volume: [71, 74, 75],
    remove: [76, 77, 78],
    interested: [76, 78, 79],

    // Common intents
    question: [3, 4, 20],
    problem: [20, 21, 27],
    issue: [20, 21, 27],
    need: [3, 4, 76],
    want: [76, 78, 79],
    call: [40, 44, 45],
    wait: [40, 44, 45],
    book: [65, 67, 69],

    // Clinic & Healthcare
    doctor: [80, 81, 82],
    appointment: [80, 82, 83],
    clinic: [80, 81, 84],
    symptom: [85, 86, 87],
    fever: [85, 86, 88],
    throat: [86, 87, 88],
    cough: [86, 88, 89],
    pain: [85, 87, 90],
    chest: [91, 92, 93],
    emergency: [91, 92, 94],
    ambulance: [91, 93, 94],
    911: [91, 92, 95],
    bleeding: [92, 93, 95],
    breathe: [91, 94, 96],
    refill: [97, 98, 99],
    prescription: [97, 98, 100],
    medication: [97, 99, 100],
    pharmacy: [98, 99, 101],

    // Fallback & Audio/Unrecognized
    fallback: [115, 116, 117],
    unrecognized: [115, 116, 118],
    understand: [115, 116, 119],
    tts: [115, 117, 119],
    audio: [115, 117, 119],
    voice: [115, 117, 120],
    speech: [115, 117, 120],
    weather: [115, 118, 121],
    rain: [115, 118, 121],
    joke: [115, 119, 122],
    sing: [115, 119, 122],
    song: [115, 119, 122],
    trivia: [115, 118, 122],
  };

  async embed(text: string): Promise<Float64Array> {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const rawTokens = cleaned.split(/\s+/).filter(Boolean);

    const tokens = rawTokens.filter((t) => !STOPWORDS.has(t));
    if (tokens.length === 0) {
      const uniform = new Float64Array(this.dimensions);
      uniform.fill(1 / Math.sqrt(this.dimensions));
      return uniform;
    }

    const keywordVec = new Float64Array(this.dimensions);
    const gramVec = new Float64Array(this.dimensions);
    const wordVec = new Float64Array(this.dimensions);

    // 1. Semantic keyword anchors — exact form first, then the stem, so that
    //    "shattered" matches directly while "shattering" resolves via stem.
    for (const token of tokens) {
      const exact = this.semanticKeywords[token];
      const stemmed = exact ? undefined : this.semanticKeywords[stem(token)];
      const anchors = exact ?? stemmed;
      if (!anchors) continue;
      for (const idx of anchors) {
        if (idx < this.dimensions) keywordVec[idx] += 1;
      }
    }

    // 2. Character 3-gram hashing — catches morphological variants the keyword
    //    table misses without needing a dictionary.
    const joined = tokens.join(" ");
    for (let i = 0; i < joined.length - 2; i++) {
      gramVec[hashBucket(joined.substring(i, i + 3), this.dimensions)] += 1;
    }

    // 3. Word-level hashing — separates words that share character grams.
    for (const token of tokens) {
      wordVec[hashBucket(token, this.dimensions)] += 1;
    }

    // 4. Normalize each signal on its own, then mix. Scale-invariant, so a long
    //    utterance cannot out-shout a short one that happens to be on-topic.
    normalize(keywordVec);
    normalize(gramVec);
    normalize(wordVec);

    const out = new Float64Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      out[i] =
        KEYWORD_WEIGHT * keywordVec[i] +
        GRAM_WEIGHT * gramVec[i] +
        WORD_WEIGHT * wordVec[i];
    }
    normalize(out);

    return out;
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
