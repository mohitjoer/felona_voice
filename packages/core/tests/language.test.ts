import { describe, it, expect } from "vitest";
import {
  normalizeLanguage,
  detectLanguage,
  describeLanguage,
  getLanguage,
  LANGUAGES,
} from "../src/i18n/language.js";

describe("language normalization", () => {
  it("passes a single tag through unchanged", () => {
    // Rewriting a caller's tag would break providers that want the exact code.
    expect(normalizeLanguage("en-GB")).toBe("en-GB");
    expect(normalizeLanguage("pt-BR")).toBe("pt-BR");
  });

  it("collapses a single-element list to that tag", () => {
    expect(normalizeLanguage(["es-ES"])).toBe("es-ES");
  });

  it("requests auto-detection for several languages", () => {
    expect(normalizeLanguage(["en-US", "es-ES"])).toBe("multi");
  });

  it("returns undefined for nothing usable", () => {
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage("")).toBeUndefined();
    expect(normalizeLanguage("   ")).toBeUndefined();
    expect(normalizeLanguage([])).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(normalizeLanguage("  fr-FR ")).toBe("fr-FR");
  });
});

describe("language detection", () => {
  it("identifies English among candidates", () => {
    expect(detectLanguage("hello I need help with my order", ["en-US", "es-ES", "fr-FR"]))
      .toBe("en-US");
  });

  it("identifies Spanish among candidates", () => {
    expect(detectLanguage("hola gracias por su ayuda", ["en-US", "es-ES", "fr-FR"]))
      .toBe("es-ES");
  });

  it("identifies French among candidates", () => {
    expect(detectLanguage("bonjour je voudrais une aide", ["en-US", "es-ES", "fr-FR"]))
      .toBe("fr-FR");
  });

  it("returns the only candidate without inspecting the text", () => {
    expect(detectLanguage("anything at all", ["de-DE"])).toBe("de-DE");
  });

  it("returns null when nothing matches or there is no text", () => {
    expect(detectLanguage("xyzzy", ["en-US", "es-ES"])).toBeNull();
    expect(detectLanguage("", ["en-US", "es-ES"])).toBeNull();
    expect(detectLanguage("hello", [])).toBeNull();
  });

  it("does not match against candidates with no markers", () => {
    expect(detectLanguage("hello there", ["zz-ZZ", "en-US"])).toBe("en-US");
  });
});

describe("language metadata", () => {
  it("looks up definitions case-insensitively", () => {
    expect(getLanguage("en-us")?.name).toBe("English (US)");
    expect(getLanguage("ES-ES")?.name).toBe("Spanish");
    expect(getLanguage("zz-ZZ")).toBeUndefined();
  });

  it("describes a single language", () => {
    expect(describeLanguage("en-US")).toBe("English (US) (en-US)");
  });

  it("describes an unknown tag as given", () => {
    expect(describeLanguage("sw-KE")).toBe("sw-KE");
  });

  it("describes several languages as auto-detecting", () => {
    expect(describeLanguage(["en-US", "fr-FR"])).toContain("auto-detecting");
  });

  it("describes an unset language as the provider default", () => {
    expect(describeLanguage(undefined)).toBe("provider default");
    expect(describeLanguage([])).toBe("provider default");
  });

  it("gives every language at least one detection marker", () => {
    for (const language of LANGUAGES) {
      expect(language.markers?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("language reaches the STT provider", () => {
  it("passes the configured language to createStream", async () => {
    const { VoicePipeline } = await import("../src/pipeline.js");
    const { JEVEngine } = await import("../src/jev/engine.js");
    const { FastSemanticEmbeddingProvider } = await import("../src/jev/fast-embeddings.js");
    const { ConversationMemory } = await import("../src/memory/context.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");
    const { CallLogger } = await import("../src/analytics/logger.js");
    const { EnergyVAD } = await import("../src/vad/energy.js");
    const type = await import("../src/types.js");

    const seen: Array<string | string[] | undefined> = [];
    const stt: type.STTProvider = {
      name: "recorder",
      createStream(options) {
        seen.push(options?.language);
        return {
          write() {},
          onResult() {},
          async close() {},
        };
      },
    };

    const jev = new JEVEngine({
      embeddingProvider: new FastSemanticEmbeddingProvider(),
    });
    await jev.initialize([
      { id: "a", description: "Do the thing", handler: async () => "ok" },
    ]);

    const make = async (language?: string | string[]) => {
      const pipeline = new VoicePipeline({
        sessionId: "s",
        session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
        stt,
        tts: { name: "t", async *synthesize() {} },
        vad: new EnergyVAD(),
        jev,
        memory: new ConversationMemory(),
        tools: new ToolRegistry(),
        logger: new CallLogger(),
        hooks: {},
        systemPrompt: "",
        sendAudio: async () => {},
        language,
      });
      await pipeline.start();
      await pipeline.stop();
    };

    await make("es-ES");
    await make(["en-US", "es-ES"]);
    await make(undefined);

    // The hardcoded "en-US" bug: a Spanish agent silently used English.
    expect(seen[0]).toBe("es-ES");
    expect(seen[1]).toBe("multi");
    // Unset must stay undefined so the provider's own default applies.
    expect(seen[2]).toBeUndefined();
  });
});
