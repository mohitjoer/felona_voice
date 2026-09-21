import type { EmbeddingProvider } from "../types.js";

/**
 * FastSemanticEmbeddingProvider
 *
 * A deterministic high-dimensional semantic vector generator (128-d)
 * optimized for real-time JEV action space routing without requiring external API keys.
 * Uses token n-grams, subword kernels, and categorical domain projection.
 */
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
    const vec = new Float64Array(this.dimensions);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const tokens = cleaned.split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      for (let i = 0; i < this.dimensions; i++) vec[i] = 1 / Math.sqrt(this.dimensions);
      return vec;
    }

    // 1. Semantic keyword anchors
    for (const token of tokens) {
      const match = this.semanticKeywords[token];
      if (match) {
        for (const idx of match) {
          if (idx < this.dimensions) {
            vec[idx] += 3.5;
          }
        }
      }
    }

    // 2. Subword character 3-grams hashing
    for (let i = 0; i < cleaned.length - 2; i++) {
      const tri = cleaned.substring(i, i + 3);
      let hash = 0;
      for (let j = 0; j < tri.length; j++) {
        hash = (hash << 5) - hash + tri.charCodeAt(j);
        hash |= 0;
      }
      const dim = Math.abs(hash) % this.dimensions;
      vec[dim] += 0.45;
    }

    // 3. Word-level hashing
    for (const token of tokens) {
      let hash = 5381;
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 33) ^ token.charCodeAt(i);
      }
      const dim = Math.abs(hash) % this.dimensions;
      vec[dim] += 0.8;
    }

    // 4. L2 Normalization to unit sphere
    let sumSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      sumSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < this.dimensions; i++) {
      vec[i] /= norm;
    }

    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
