import {
  extractDigits,
  normalizeSpoken,
  spokenSymbolsToLiteral,
  stripFillers,
  tokenize,
} from "./spoken.js";

/**
 * Slot value types.
 *
 * Each type pairs an extractor (pull a candidate out of a spoken utterance)
 * with a validator (decide whether the candidate is actually usable). Speech is
 * unreliable input, so both halves are deliberately forgiving on format and
 * strict on meaning.
 */
export type SlotType =
  | "string"
  | "name"
  | "email"
  | "phone"
  | "zip"
  | "cardNumber"
  | "expiry"
  | "cvv"
  | "address"
  | "number"
  | "date";

export interface ExtractionResult {
  /** Whether a value was found. */
  found: boolean;
  /** The extracted value, normalized. */
  value?: string;
  /** Explanation when `found` is false — useful for prompting. */
  reason?: string;
}

export interface ValidationResult {
  valid: boolean;
  /** The canonical value to store, when valid. */
  value?: string;
  /** Human-readable reason, used to re-prompt. */
  message?: string;
}

/** Words that mark a correction: "no it's ...", "actually ...". */
const CORRECTION_PREFIXES = [
  "no it is", "no its", "no it's", "nope", "actually", "sorry", "i mean",
  "correct is", "rather", "instead",
];

/**
 * Detect and strip a self-correction.
 *
 * "no it's john not jane" means the caller is replacing their answer, so the
 * correction marker must not end up inside the captured value.
 */
export function stripCorrection(text: string): string {
  let working = text.trim();
  for (const prefix of CORRECTION_PREFIXES) {
    if (working.toLowerCase().startsWith(prefix)) {
      working = working.slice(prefix.length).trim();
      break;
    }
  }
  return working;
}

/**
 * Remove a trailing filler clause.
 *
 * "john smith at gmail dot com" should yield an email, not a name; and
 * "5551234567 for my account" should yield digits. The caller decides which
 * type it wanted, and the extractor for that type is responsible for finding
 * its own pattern.
 */
export function extractEmail(text: string): ExtractionResult {
  const working = stripCorrection(spokenSymbolsToLiteral(text));

  // Already a well-formed address (recognizer emitted it verbatim).
  const direct = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(working);
  if (direct) {
    return { found: true, value: direct[0].toLowerCase() };
  }

  // Spoken form: "jane . doe @ gmail . com". The local part may be spoken with
  // spaces around its dots and underscores, so whitespace is allowed between
  // segments and stripped afterwards. Requiring both halves avoids matching
  // "at home" as an address.
  const spoken = /([a-z0-9][a-z0-9._%+-]*(?:\s*[._-]\s*[a-z0-9][a-z0-9._%+-]*)*)\s*@\s*([a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)+)/i.exec(
    working,
  );
  if (spoken) {
    const local = spoken[1].replace(/\s+/g, "");
    const domain = spoken[2].replace(/\s+/g, "").toLowerCase();
    return { found: true, value: `${local}@${domain}` };
  }

  return { found: false, reason: "no email address detected" };
}

/** Validate a normalized email address. */
export function validateEmail(value: string): ValidationResult {
  const candidate = value.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)) {
    return { valid: false, message: "That does not look like an email address." };
  }
  if (/\.\./.test(candidate) || candidate.startsWith(".") || candidate.includes(".@")) {
    return { valid: false, message: "That email address has a formatting problem." };
  }
  // The TLD is the final dot-separated segment of the domain.
  const domain = candidate.slice(candidate.indexOf("@") + 1);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2) {
    return { valid: false, message: "Please give the full email domain." };
  }
  return { valid: true, value: candidate };
}

/**
 * Extract a phone number.
 *
 * Handles spoken digits, and tolerates a caller dictating a number with groups
 * ("five five five, one two three, four five six seven").
 */
export function extractPhone(text: string): ExtractionResult {
  const working = stripCorrection(text);

  // Prefer a contiguous run of at least 7 digits.
  const runs = working.match(/\d[\d\s().-]{5,}\d/g) ?? [];
  let best = "";
  for (const run of runs) {
    const digits = extractDigits(run);
    if (digits.length > best.length) best = digits;
  }

  if (best.length >= 7) {
    return { found: true, value: best };
  }

  // Otherwise treat the whole utterance as spoken digits.
  const all = extractDigits(working);
  if (all.length >= 7) {
    return { found: true, value: all };
  }

  return { found: false, reason: "not enough digits" };
}

/** Validate a normalized phone number: 7-15 digits, plausible. */
export function validatePhone(value: string): ValidationResult {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) {
    return { valid: false, message: "That phone number looks too short." };
  }
  if (digits.length > 15) {
    return { valid: false, message: "That phone number looks too long." };
  }
  // NANP: an area code cannot start with 0 or 1.
  if (digits.length === 10 && (digits[0] === "0" || digits[0] === "1")) {
    return { valid: false, message: "Please give a 10-digit number including area code." };
  }
  if (digits.length === 11 && digits[0] === "1") {
    return { valid: true, value: digits };
  }
  return { valid: true, value: digits };
}

/** Luhn checksum — the only cheap way to catch a misheard card digit. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Extract a card number, tolerating "four one two three" style dictation. */
export function extractCardNumber(text: string): ExtractionResult {
  const digits = extractDigits(stripCorrection(text));
  if (digits.length < 12) {
    return { found: false, reason: "a card number is 12 to 19 digits" };
  }
  if (digits.length > 19) {
    return { found: false, reason: "that is longer than a card number" };
  }
  return { found: true, value: digits };
}

export function validateCardNumber(value: string): ValidationResult {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return { valid: false, message: "Card numbers are 13 to 19 digits long." };
  }
  if (!luhnValid(digits)) {
    // The most common real failure: one digit misheard over the phone.
    return {
      valid: false,
      message: "That card number did not check out. Could you read it again, digit by digit?",
    };
  }
  return { valid: true, value: digits };
}

/** Extract an expiry as MMYY from "march 2027", "03 27", "3/27". */
export function extractExpiry(text: string): ExtractionResult {
  const working = stripCorrection(text).toLowerCase();

  const months: Record<string, string> = {
    january: "01", jan: "01", february: "02", feb: "02", march: "03", mar: "03",
    april: "04", apr: "04", may: "05", june: "06", jun: "06", july: "07",
    jul: "07", august: "08", aug: "08", september: "09", sep: "09", sept: "09",
    october: "10", oct: "10", november: "11", nov: "11", december: "12", dec: "12",
  };

  for (const [name, value] of Object.entries(months)) {
    if (new RegExp(`\\b${name}\\b`).test(working)) {
      const year = /\b(20\d{2}|\d{2})\b/.exec(working.replace(name, ""));
      const yy = year ? year[1] : "";
      if (yy.length === 2) {
        return { found: true, value: `${value}${yy}` };
      }
      if (yy.length === 4) {
        return { found: true, value: `${value}${yy.slice(2)}` };
      }
    }
  }

  // Numeric forms: "03/27", "3 27", "0327".
  //
  // The boundaries matter: without them this pattern matches inside any long
  // digit run, so a spoken 16-digit card number yields a bogus "4539" expiry.
  const numeric =
    /(?<!\d)(\d{1,2})\s*[/\-\s]\s*(\d{2}|\d{4})(?!\d)/.exec(working) ??
    /(?<!\d)(\d{2})(\d{2})(?!\d)/.exec(working);

  if (numeric) {
    const month = numeric[1].padStart(2, "0");
    const year = numeric[2].length === 4 ? numeric[2].slice(2) : numeric[2];
    return { found: true, value: `${month}${year}` };
  }

  return { found: false, reason: "could not read an expiry date" };
}

export function validateExpiry(value: string): ValidationResult {
  const match = /^(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) {
    return { valid: false, message: "Please give the expiry as month and year." };
  }
  const month = Number(match[1]);
  if (month < 1 || month > 12) {
    return { valid: false, message: "That is not a valid month." };
  }
  return { valid: true, value: value.trim() };
}

/** Month names, used to spot expiry context. */
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "expiry", "expiration", "expires",
];

/**
 * Extract a 3 or 4 digit CVV.
 *
 * Two guards, both needed in practice:
 * - Expiry context disqualifies the utterance. "march 2027" is otherwise a
 *   perfect-looking 4-digit value, and would silently become the security code.
 * - A 4-digit value that is a plausible calendar year is rejected for the same
 *   reason. Real 4-digit CVVs (Amex) hitting 19xx/20xx is a rare coincidence,
 *   and a re-ask is cheaper than charging a card with a wrong CVV.
 */
export function extractCvv(text: string): ExtractionResult {
  const cleaned = stripCorrection(text);
  const lower = ` ${cleaned.toLowerCase()} `;

  for (const month of MONTH_NAMES) {
    if (lower.includes(` ${month} `)) {
      return { found: false, reason: "that reads as an expiry date" };
    }
  }

  const digits = extractDigits(cleaned);
  if (digits.length !== 3 && digits.length !== 4) {
    return { found: false, reason: "the security code is 3 or 4 digits" };
  }

  if (digits.length === 4 && /^(19|20)\d{2}$/.test(digits)) {
    return { found: false, reason: "that looks like a year, not a security code" };
  }

  return { found: true, value: digits };
}

export function validateCvv(value: string): ValidationResult {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 3 && digits.length !== 4) {
    return { valid: false, message: "The security code is 3 or 4 digits." };
  }
  return { valid: true, value: digits };
}

/**
 * Extract a US ZIP code, spoken or literal.
 */
export function extractZip(text: string): ExtractionResult {
  const working = stripCorrection(text);
  const match = /\b(\d{5})(?:[-\s](\d{4}))?\b/.exec(working);
  if (match) {
    return { found: true, value: match[2] ? `${match[1]}-${match[2]}` : match[1] };
  }
  return { found: false, reason: "no 5-digit ZIP code detected" };
}

export function validateZip(value: string): ValidationResult {
  if (!/^\d{5}(-\d{4})?$/.test(value.trim())) {
    return { valid: false, message: "Please give a 5-digit ZIP code." };
  }
  return { valid: true, value: value.trim() };
}

/**
 * Extract a person's name.
 *
 * Conservative by design: it only fires on an explicit introduction, because
 * guessing a name from arbitrary speech produces confident nonsense.
 */
export function extractName(text: string): ExtractionResult {
  const working = stripCorrection(text);

  // "my name is X", "I'm X", "this is X", "my name's X"
  const introduced =
    /\b(?:my name is|my name's|name is|i am|i'm|this is|it's|call me)\s+([a-z][a-z' -]{1,60})/i.exec(
      working,
    );
  if (introduced) {
    const value = cleanName(introduced[1]);
    if (value.length >= 2) {
      return { found: true, value };
    }
  }

  // A bare capitalized name, only when the utterance is short — a long
  // sentence is a sentence, not a name.
  if (tokenize(working).length <= 4) {
    const bare = cleanName(working);
    if (bare.length >= 2 && /^[A-Z]/.test(bare) && !/[@\d]/.test(bare)) {
      return { found: true, value: bare };
    }
  }

  return { found: false, reason: "no name detected" };
}

function cleanName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z' .-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(and|but|so|um|uh)\s+/i, "")
    .trim()
    .replace(/[.,]$/, "");
}

export function validateName(value: string): ValidationResult {
  const cleaned = cleanName(value);
  if (cleaned.length < 2) {
    return { valid: false, message: "Could you say the name again?" };
  }
  if (!/[a-zA-Z]/.test(cleaned)) {
    return { valid: false, message: "That does not look like a name." };
  }
  if (tokenize(cleaned).length > 5) {
    return { valid: false, message: "Just the name, please." };
  }
  return { valid: true, value: cleaned };
}

/**
 * Extract a street address.
 *
 * Requires a number plus a street-type word, which is the cheapest reliable
 * signal that a caller dictated an address rather than something else.
 */
const STREET_TYPES = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive",
  "dr", "lane", "ln", "court", "ct", "place", "pl", "terrace", "ter", "way",
  "circle", "cir", "parkway", "pkwy", "highway", "hwy", "square", "sq",
]);

export function extractAddress(text: string): ExtractionResult {
  const original = stripCorrection(text).replace(/\s+/g, " ").trim();
  if (!original) {
    return { found: false, reason: "nothing to capture" };
  }

  // Work from the caller's own tokens so the captured address keeps its casing
  // ("1600 Pennsylvania Avenue"). Normalization is only needed when the street
  // number was spoken ("one hundred sixty"), which is rare enough to be a
  // fallback rather than the main path.
  let tokens = original.split(" ");
  if (!tokens.some((token) => /^\d/.test(token))) {
    const normalized = normalizeSpoken(original).split(" ");
    if (normalized.some((token) => /^\d/.test(token))) {
      tokens = normalized;
    }
  }

  const numberIndex = tokens.findIndex((token) => /^\d+[a-z]?$/i.test(token));
  if (numberIndex === -1) {
    return { found: false, reason: "no street number detected" };
  }

  const hasStreetType = tokens.some((token) =>
    STREET_TYPES.has(token.toLowerCase().replace(/[.,]/g, "")),
  );
  if (!hasStreetType) {
    return { found: false, reason: "no street type detected" };
  }

  const value = tokens
    .slice(numberIndex)
    .join(" ")
    .replace(/[.,]+$/, "")
    .trim();

  if (value.length < 4) {
    return { found: false, reason: "address too short" };
  }
  return { found: true, value };
}

export function validateAddress(value: string): ValidationResult {
  if (extractAddress(value).found) {
    return { valid: true, value: value.trim() };
  }
  return {
    valid: false,
    message: "Please give the street address, including the number and street name.",
  };
}

/** Cardinal number words, for spoken quantities. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Compose a spoken number.
 *
 * Handles the additive cases that actually occur on a call ("twenty five",
 * "one hundred twenty") and treats "hundred"/"thousand" as multipliers.
 */
function composeNumberWords(tokens: string[]): number | null {
  const relevant = tokens.filter((token) => NUMBER_WORDS[token] !== undefined || token === "hundred" || token === "thousand");
  if (relevant.length === 0) return null;

  let total = 0;
  let current = 0;
  let sawAny = false;

  for (const token of relevant) {
    if (token === "hundred") {
      current = (current || 1) * 100;
    } else if (token === "thousand") {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
    } else {
      current += NUMBER_WORDS[token];
    }
    sawAny = true;
  }

  return sawAny ? total + current : null;
}

/** Extract a plain number, spoken or literal. */
export function extractNumber(text: string): ExtractionResult {
  const cleaned = stripCorrection(text);
  const tokens = tokenize(cleaned);

  // Purely spoken numbers must be composed before digit extraction, or
  // "twenty five" digitizes to just "5" because "five" is also a digit word.
  const hasBareDigits = /\d/.test(cleaned);
  if (!hasBareDigits) {
    const composed = composeNumberWords(tokens);
    if (composed !== null) {
      return { found: true, value: String(composed) };
    }
  }

  const digits = extractDigits(cleaned);
  if (digits) {
    return { found: true, value: digits };
  }

  return { found: false, reason: "no number detected" };
}

export function validateNumber(value: string): ValidationResult {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return { valid: false, message: "Please give a number." };
  }
  return { valid: true, value: value.trim() };
}

/** Extract a spoken date, normalized to YYYY-MM-DD where unambiguous. */
export function extractDate(text: string): ExtractionResult {
  const working = stripCorrection(text).toLowerCase();

  // ISO or numeric: 2026-03-14, 03/14/2026
  const numeric =
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(working) ??
    /\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/.exec(working);

  if (numeric) {
    const [y, m, d] =
      numeric[1].length === 4
        ? [numeric[1], numeric[2], numeric[3]]
        : [numeric[3], numeric[1], numeric[2]];
    const value = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (validateDate(value).valid) {
      return { found: true, value };
    }
  }

  // "march 14 2026" / "14 march 2026"
  const months: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4,
    apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11,
    nov: 11, december: 12, dec: 12,
  };

  for (const [name, month] of Object.entries(months)) {
    if (new RegExp(`\\b${name}\\b`).test(working)) {
      const rest = working.replace(name, " ");
      const day = /\b(\d{1,2})\b/.exec(rest);
      const year = /\b(20\d{2})\b/.exec(rest);
      if (day) {
        const value = `${year ? year[1] : "0000"}-${String(month).padStart(2, "0")}-${day[1].padStart(2, "0")}`;
        return { found: true, value };
      }
    }
  }

  return { found: false, reason: "could not read a date" };
}

export function validateDate(value: string): ValidationResult {
  const trimmed = value.trim();
  // A year of 0000 means the caller gave no year.
  if (/^0000-/.test(trimmed)) {
    return { valid: false, message: "Please include the year." };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return { valid: false, message: "Please give the date." };
  }
  const [, y, m, d] = match.map(Number) as unknown as [string, number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return { valid: false, message: "That is not a valid date." };
  }
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) {
    return { valid: false, message: "That date does not exist." };
  }
  return { valid: true, value: trimmed };
}

/** Strip filler words, for free-text slots. */
export function extractString(text: string): ExtractionResult {
  const value = stripFillers(stripCorrection(text));
  if (!value) {
    return { found: false, reason: "nothing to capture" };
  }
  return { found: true, value };
}

export function validateString(value: string): ValidationResult {
  if (value.trim().length < 2) {
    return { valid: false, message: "Could you say that again?" };
  }
  return { valid: true, value: value.trim() };
}

/** Extractor per slot type. */
export const EXTRACTORS: Record<SlotType, (text: string) => ExtractionResult> = {
  string: extractString,
  name: extractName,
  email: extractEmail,
  phone: extractPhone,
  zip: extractZip,
  cardNumber: extractCardNumber,
  expiry: extractExpiry,
  cvv: extractCvv,
  address: extractAddress,
  number: extractNumber,
  date: extractDate,
};

/** Validator per slot type. */
export const VALIDATORS: Record<SlotType, (value: string) => ValidationResult> = {
  string: validateString,
  name: validateName,
  email: validateEmail,
  phone: validatePhone,
  zip: validateZip,
  cardNumber: validateCardNumber,
  expiry: validateExpiry,
  cvv: validateCvv,
  address: validateAddress,
  number: validateNumber,
  date: validateDate,
};

/** Built-in prompt wording per slot type, used when none is supplied. */
export const DEFAULT_PROMPTS: Record<SlotType, string> = {
  string: "Could you tell me that?",
  name: "What is your name?",
  email: "What is your email address?",
  phone: "What is the best phone number to reach you?",
  zip: "What is your ZIP code?",
  cardNumber: "What is the card number?",
  expiry: "What is the expiration date, month and year?",
  cvv: "What is the security code on the back?",
  address: "What is the shipping address?",
  number: "What is the number?",
  date: "What is the date?",
};
