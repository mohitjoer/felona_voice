import { describe, it, expect } from "vitest";
import {
  extractEmail,
  validateEmail,
  extractPhone,
  validatePhone,
  extractCardNumber,
  validateCardNumber,
  luhnValid,
  extractExpiry,
  validateExpiry,
  extractZip,
  extractName,
  validateName,
  extractAddress,
  extractNumber,
  extractDate,
  validateDate,
  extractCvv,
  stripCorrection,
} from "../src/slots/extractors.js";
import {
  spokenDigitsToLiteral,
  spokenSymbolsToLiteral,
  extractDigits,
  stripFillers,
} from "../src/slots/spoken.js";

describe("spoken form normalization", () => {
  it("converts spoken digits to literals", () => {
    expect(spokenDigitsToLiteral("one two three four five six seven eight nine zero"))
      .toBe("1 2 3 4 5 6 7 8 9 0");
  });

  it("expands triple and double", () => {
    expect(extractDigits("triple five")).toBe("555");
    expect(extractDigits("double seven")).toBe("77");
    expect(extractDigits("triple five double two")).toBe("55522");
  });

  it("handles homophone digit words", () => {
    expect(extractDigits("fife")).toBe("5");
    expect(extractDigits("tree")).toBe("3");
    expect(extractDigits("to")).toBe("2");
    expect(extractDigits("ate")).toBe("8");
  });

  it("strips ordinal suffixes", () => {
    expect(extractDigits("room 3rd")).toBe("3");
    expect(extractDigits("the 21st")).toBe("21");
  });

  it("converts spoken symbols", () => {
    expect(spokenSymbolsToLiteral("john at gmail dot com")).toContain("@");
    expect(spokenSymbolsToLiteral("john at gmail dot com")).toContain(".");
  });

  it("prefers multi-word symbols over single words", () => {
    // "at sign" must not become "@sign"
    expect(spokenSymbolsToLiteral("at sign")).toBe("@");
  });

  it("removes fillers but keeps meaningful words", () => {
    // "like" is a filler here — "I would like" carries no content.
    expect(stripFillers("um I would like to please get a refund")).toBe("would get refund");
    expect(stripFillers("New York")).toBe("New York");
  });
});

describe("email extraction", () => {
  it("reads a literal address", () => {
    const result = extractEmail("my email is jane.doe@example.com");
    expect(result.found).toBe(true);
    expect(result.value).toBe("jane.doe@example.com");
  });

  it("reads the spoken form", () => {
    const result = extractEmail("jane dot doe at gmail dot com");
    expect(result.found).toBe(true);
    expect(result.value).toBe("jane.doe@gmail.com");
  });

  it("reads an underscore", () => {
    const result = extractEmail("jane underscore doe at mail dot com");
    expect(result.value).toBe("jane_doe@mail.com");
  });

  it("strips a self-correction", () => {
    expect(extractEmail("no it's jane at gmail dot com").value).toBe("jane@gmail.com");
  });

  it("does not invent an address from unrelated speech", () => {
    expect(extractEmail("I want to return a product").found).toBe(false);
    expect(extractEmail("call me at home").found).toBe(false);
  });

  it("validates format", () => {
    expect(validateEmail("Jane.Doe+tag@Example.com")).toEqual({
      valid: true,
      value: "jane.doe+tag@example.com",
    });
    expect(validateEmail("not-an-email").valid).toBe(false);
    expect(validateEmail("a@b").valid).toBe(false);
    expect(validateEmail("a..b@example.com").valid).toBe(false);
    expect(validateEmail("a@example.c").valid).toBe(false);
  });
});

describe("phone extraction", () => {
  it("reads spoken digits with grouping", () => {
    expect(extractPhone("five five five one two three four five six seven").value)
      .toBe("5551234567");
  });

  it("reads a formatted number", () => {
    expect(extractPhone("my number is (555) 123-4567").value).toBe("5551234567");
  });

  it("ignores an incidental number that is too short", () => {
    expect(extractPhone("I have 3 questions").found).toBe(false);
  });

  it("validates length and NANP area codes", () => {
    expect(validatePhone("5551234567").valid).toBe(true);
    expect(validatePhone("1234567").valid).toBe(true);
    expect(validatePhone("12345").valid).toBe(false);
    expect(validatePhone("0123456789").valid).toBe(false);
  });
});

describe("card extraction", () => {
  const valid = "4539578763621486";

  it("accepts a Luhn-valid number", () => {
    expect(luhnValid(valid)).toBe(true);
    expect(validateCardNumber(valid).valid).toBe(true);
  });

  it("rejects a single misheard digit", () => {
    // The realistic failure: one digit wrong over the phone.
    expect(validateCardNumber("4539578763621487").valid).toBe(false);
  });

  it("reads spoken digits", () => {
    const spoken =
      "four five three nine five seven eight seven six three six two one four eight six";
    expect(extractCardNumber(spoken).value).toBe(valid);
  });

  it("rejects an implausible length", () => {
    expect(extractCardNumber("one two three").found).toBe(false);
  });
});

describe("expiry extraction", () => {
  it("reads a spoken month and year", () => {
    expect(extractExpiry("march 2027").value).toBe("0327");
  });

  it("reads a numeric form", () => {
    expect(extractExpiry("03/27").value).toBe("0327");
    expect(extractExpiry("3 27").value).toBe("0327");
  });

  it("validates the month", () => {
    expect(validateExpiry("0327").valid).toBe(true);
    expect(validateExpiry("1327").valid).toBe(false);
    expect(validateExpiry("03").valid).toBe(false);
  });
});

describe("zip, cvv, number, date", () => {
  it("reads a ZIP", () => {
    expect(extractZip("my zip is 94103").value).toBe("94103");
    expect(extractZip("I live in 94103-1234").value).toBe("94103-1234");
  });

  it("reads a CVV", () => {
    expect(extractCvv("the code is four one two").value).toBe("412");
    expect(extractCvv("one two").found).toBe(false);
  });

  it("reads numbers, spoken and literal", () => {
    expect(extractNumber("the total is 47 dollars").value).toBe("47");
    expect(extractNumber("I need twenty five").value).toBe("25");
  });

  it("reads dates", () => {
    expect(validateDate(extractDate("2026-03-14").value ?? "").valid).toBe(true);
    expect(validateDate(extractDate("march 14 2026").value ?? "").valid).toBe(true);
    expect(validateDate("2026-02-30").valid).toBe(false);
  });
});

describe("name extraction", () => {
  it("reads an explicit introduction", () => {
    expect(extractName("my name is Jane Doe").value).toBe("Jane Doe");
    expect(extractName("I'm Alex").value).toBe("Alex");
  });

  it("reads a short bare name", () => {
    expect(extractName("Jane Doe").value).toBe("Jane Doe");
  });

  it("does not invent a name from a sentence", () => {
    // The failure mode this guards: confidently capturing half a sentence.
    expect(extractName("I was calling about my order last week").found).toBe(false);
  });

  it("validates", () => {
    expect(validateName("Jane Doe").valid).toBe(true);
    expect(validateName("x").valid).toBe(false);
    expect(validateName("one two three four five six").valid).toBe(false);
  });
});

describe("address extraction", () => {
  it("reads a street address", () => {
    expect(extractAddress("it's 1600 Pennsylvania Avenue").value)
      .toBe("1600 Pennsylvania Avenue");
    expect(extractAddress("42 Oak Street").value).toBe("42 Oak Street");
  });

  it("requires both a number and a street type", () => {
    expect(extractAddress("I met him yesterday").found).toBe(false);
    expect(extractAddress("Pennsylvania Avenue").found).toBe(false);
  });
});

describe("correction stripping", () => {
  it("removes common correction prefixes", () => {
    expect(stripCorrection("no it's John")).toBe("John");
    expect(stripCorrection("actually Marie")).toBe("Marie");
    expect(stripCorrection("Jane")).toBe("Jane");
  });
});
