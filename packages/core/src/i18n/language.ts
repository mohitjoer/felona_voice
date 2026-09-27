/**
 * Speech language configuration.
 *
 * Kept separate from the providers because the rules are ours, not theirs:
 * recognizers disagree on tag format, several only accept a single language at
 * a time, and a multi-language agent needs an explicit policy rather than
 * whatever the provider defaults to.
 */

/** A language the framework can be configured for. */
export interface LanguageDefinition {
  /** BCP-47 tag passed to the STT provider, e.g. `en-US`. */
  tag: string;
  /** Human-readable name, used in logs and errors. */
  name: string;
  /**
   * Words that strongly indicate this language, used for auto-detection when
   * an agent accepts several.
   */
  markers?: string[];
}

/**
 * Normalize a configured language into what gets handed to the STT provider.
 *
 * A list means "accept any of these", so the recognizer should auto-detect;
 * most providers express that as `multi`. A single tag is passed through
 * unchanged, because rewriting it would break providers that want the exact
 * code they were given.
 */
export function normalizeLanguage(
  language: string | string[] | undefined,
): string | undefined {
  if (language === undefined) return undefined;

  if (typeof language === "string") {
    const trimmed = language.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!Array.isArray(language) || language.length === 0) return undefined;

  const tags = language.map((tag) => tag.trim()).filter(Boolean);
  if (tags.length === 0) return undefined;
  if (tags.length === 1) return tags[0];

  // Auto-detect among the accepted languages.
  return "multi";
}

/**
 * Detect the language of a transcript from its most common words.
 *
 * Deliberately simple: this only has to break ties between the languages an
 * agent declared support for, not identify arbitrary text. A stopword-frequency
 * vote is enough for that and needs no model.
 */
export function detectLanguage(
  text: string,
  candidates: string[],
): string | null {
  if (!text.trim() || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const words = text
    .toLowerCase()
    .replace(/[^a-zà-ÿ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return null;

  const wordSet = new Set(words);
  let best: string | null = null;
  let bestScore = 0;

  for (const tag of candidates) {
    const definition = LANGUAGES.find((lang) => lang.tag === tag);
    const markers = definition?.markers ?? [];
    if (markers.length === 0) continue;

    const hits = markers.filter((marker) => wordSet.has(marker)).length;
    if (hits > bestScore) {
      bestScore = hits;
      best = tag;
    }
  }

  return best;
}

/** Languages with markers for auto-detection. Extend as needed. */
export const LANGUAGES: LanguageDefinition[] = [
  {
    tag: "en-US",
    name: "English (US)",
    markers: [
      "the", "and", "is", "are", "you", "your", "please", "thank", "thanks",
      "hello", "hi", "help", "want", "need", "have", "what", "where", "when",
    ],
  },
  {
    tag: "es-ES",
    name: "Spanish",
    markers: [
      "hola", "gracias", "por", "favor", "quiero", "necesito", "dónde", "donde",
      "cuando", "sí", "usted", "ayuda", "el", "la", "los", "las", "es", "mi",
    ],
  },
  {
    tag: "fr-FR",
    name: "French",
    markers: [
      "bonjour", "merci", "s'il", "vous", "je", "voudrais", "besoin", "où",
      "quand", "oui", "aide", "le", "la", "les", "est", "mon", "ma", "un",
    ],
  },
  {
    tag: "de-DE",
    name: "German",
    markers: [
      "hallo", "danke", "bitte", "ich", "möchte", "brauche", "wo", "wann",
      "ja", "hilfe", "der", "die", "das", "ist", "mein", "meine", "ein",
    ],
  },
  {
    tag: "pt-BR",
    name: "Portuguese (Brazil)",
    markers: [
      "olá", "ola", "obrigado", "obrigada", "por", "favor", "quero",
      "preciso", "onde", "quando", "sim", "ajuda", "o", "a", "os", "as", "meu",
    ],
  },
  {
    tag: "it-IT",
    name: "Italian",
    markers: [
      "ciao", "grazie", "per", "favore", "vorrei", "bisogno", "dove", "quando",
      "sì", "aiuto", "il", "lo", "la", "gli", "è", "mio", "mia",
    ],
  },
  {
    tag: "hi-IN",
    name: "Hindi",
    markers: ["नमस्ते", "धन्यवाद", "कृपया", "मुझे", "चाहिए", "कहाँ", "कब", "हाँ", "मदद"],
  },
];

/** Look up a language definition by tag, case-insensitively. */
export function getLanguage(tag: string): LanguageDefinition | undefined {
  const lower = tag.toLowerCase();
  return LANGUAGES.find((lang) => lang.tag.toLowerCase() === lower);
}

/**
 * Validate a configured language.
 *
 * Unknown tags are not rejected — providers add locales faster than this list,
 * and a valid-but-unlisted tag should still work. This is advisory.
 */
export function describeLanguage(language: string | string[] | undefined): string {
  if (language === undefined) return "provider default";

  const tags = Array.isArray(language) ? language : [language];
  if (tags.length === 0) return "provider default";

  const described = tags.map((tag) => {
    const known = getLanguage(tag);
    return known ? `${known.name} (${known.tag})` : tag;
  });

  return tags.length === 1 ? described[0] : `${described.join(", ")} — auto-detecting`;
}
