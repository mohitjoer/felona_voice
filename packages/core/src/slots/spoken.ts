/**
 * Spoken-form normalization for slot extraction.
 *
 * Voice transcripts are not typed text. Callers say "at gmail dot com" and
 * "one two three dash four five six", and recognizers variously emit "3rd",
 * "double five" or "fife" for the same thing. Extracting an email or card
 * number without handling these forms fails on exactly the input it exists to
 * capture, so all normalization lives here.
 */

/** Number words and the digits they stand for. */
const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nil: "0", nought: "0",
  one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", tree: "3",
  four: "4", for: "4", fore: "4", five: "5", fife: "5", six: "6", seven: "7",
  eight: "8", ate: "8", nine: "9", niner: "9",
};

/** Punctuation and symbol words. Multi-word entries are matched first. */
const SYMBOL_WORDS: Record<string, string> = {
  "at sign": "@",
  at: "@",
  dot: ".",
  period: ".",
  "full stop": ".",
  dash: "-",
  hyphen: "-",
  minus: "-",
  underscore: "_",
  "underscore bar": "_",
  slash: "/",
  "forward slash": "/",
  space: " ",
  blank: " ",
  pound: "#",
  hash: "#",
  star: "*",
  asterisk: "*",
  plus: "+",
  ampersand: "&",
  and: "&",
  equals: "=",
  equalsign: "=",
};

/** Ordinal and cardinal suffixes that turn "3rd" into "3". */
const ORDINAL_SUFFIX = /(st|nd|rd|th)$/;

/** Words that carry no meaning for extraction. */
const FILLER_WORDS = new Set([
  "um", "uh", "erm", "like", "please", "thanks", "thank", "you", "my", "is",
  "it", "its", "a", "an", "the", "and", "so", "yeah", "okay", "ok", "well",
  "i", "me", "to", "for", "that", "this", "with", "have", "has", "be", "am",
]);

/**
 * Convert spoken digits in free text to literal digits.
 *
 * Handles "one two three", "triple five" → 555, "double two" → 22, and ordinal
 * suffixes like "3rd". Non-numeric words are preserved so the caller can still
 * see them.
 */
export function spokenDigitsToLiteral(text: string): string {
  const tokens = tokenize(text);
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // "triple five" / "double seven"
    if ((token === "triple" || token === "double") && tokens[i + 1]) {
      const digit = DIGIT_WORDS[tokens[i + 1]];
      if (digit) {
        out.push(digit.repeat(token === "triple" ? 3 : 2));
        i++;
        continue;
      }
    }

    if (DIGIT_WORDS[token] !== undefined) {
      out.push(DIGIT_WORDS[token]);
      continue;
    }

    // A bare number, optionally with an ordinal suffix: "123", "3rd"
    const bare = token.replace(ORDINAL_SUFFIX, "");
    if (/^\d+$/.test(bare)) {
      out.push(bare);
      continue;
    }

    out.push(token);
  }

  return out.join(" ");
}

/**
 * Normalize spoken punctuation to literal symbols.
 *
 * Multi-word symbols are matched first so "at sign" does not become "@sign".
 */
export function spokenSymbolsToLiteral(text: string): string {
  let working = ` ${text.toLowerCase()} `;

  // Longest phrases first.
  const phrases = Object.keys(SYMBOL_WORDS)
    .filter((key) => key.includes(" "))
    .sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    working = working.split(` ${phrase} `).join(` ${SYMBOL_WORDS[phrase]} `);
  }

  const words = tokenize(working);
  const out = words.map((word) => SYMBOL_WORDS[word] ?? word);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Best-effort conversion of a spoken value into typed form.
 *
 * Applies symbol and digit normalization, then removes filler words only when
 * `stripFiller` is set — names and addresses legitimately contain short words.
 */
export function normalizeSpoken(
  text: string,
  options: { stripFiller?: boolean } = {},
): string {
  let working = spokenSymbolsToLiteral(spokenDigitsToLiteral(text));

  if (options.stripFiller) {
    const words = tokenize(working).filter((word) => !FILLER_WORDS.has(word));
    working = words.join(" ");
  }

  return working.replace(/\s+/g, " ").trim();
}

/** Extract every digit character from text, spoken or literal. */
export function extractDigits(text: string): string {
  return spokenDigitsToLiteral(text).replace(/\D/g, "");
}

/** Lowercase, punctuation-free tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@._+\-\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Remove filler words while preserving the original casing of what remains. */
export function stripFillers(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9\s'.-]/g, " ").replace(/\s+/g, " ").trim();
  const parts = cleaned.split(" ");
  const kept = parts.filter((part) => !FILLER_WORDS.has(part.toLowerCase()));
  return (kept.length > 0 ? kept : parts).join(" ").trim();
}
