import { describe, it, expect, vi } from "vitest";
import {
  buildTransferTwiml,
  TwilioTransferProvider,
  createTwilioTransferProvider,
} from "../src/telephony/transfer.js";
import { CallSupervisor } from "../src/supervision/controller.js";
import { createSupportAgent } from "../src/builder.js";
import type { AudioChunk, Session, Transport } from "../src/types.js";

const twilioSession = (overrides: Record<string, unknown> = {}) => ({
  id: "MZ123",
  metadata: { telephony: "twilio", callSid: "CA123", ...overrides },
});

describe("transfer TwiML", () => {
  it("dials a phone number", () => {
    const xml = buildTransferTwiml({ to: "+15551234567" });
    expect(xml).toContain("<Number>+15551234567</Number>");
    expect(xml).toContain("<Dial>");
  });

  it("dials a SIP URI directly", () => {
    const xml = buildTransferTwiml({ to: "sip:agent@example.com" });
    expect(xml).toContain("sip:agent@example.com");
    // A SIP destination is dialled directly, not wrapped in <Number>.
    expect(xml).not.toContain("<Number>");
  });

  it("passes context as parameters", () => {
    const xml = buildTransferTwiml({
      to: "+15551234567",
      context: { reason: "supervisor requested", orderId: "ACM-1" },
    });
    expect(xml).toContain('name="reason" value="supervisor requested"');
    expect(xml).toContain('name="orderId" value="ACM-1"');
  });

  it("escapes XML in destinations and context", () => {
    const xml = buildTransferTwiml({
      to: '+15551234567"><script>alert(1)</script>',
      context: { bad: 'a & "b" <c>' },
    });
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
  });

  it("drops context keys that are not valid header names", () => {
    const xml = buildTransferTwiml({
      to: "+15551234567",
      context: { "bad key!": "x", good: "y" },
    });
    expect(xml).not.toContain("bad key");
    expect(xml).toContain('name="good"');
  });
});

describe("TwilioTransferProvider", () => {
  it("requires credentials at construction", () => {
    expect(() => createTwilioTransferProvider({ accountSid: "", authToken: "" })).toThrow(
      /accountSid and authToken/,
    );
  });

  it("only claims sessions it can actually transfer", () => {
    const provider = createTwilioTransferProvider({
      accountSid: "AC1",
      authToken: "token",
    });

    expect(provider.canTransfer(twilioSession())).toBe(true);
    // No callSid, or not telephony at all.
    expect(provider.canTransfer({ id: "x", metadata: {} })).toBe(false);
    expect(provider.canTransfer({ id: "x", metadata: { telephony: "twilio" } })).toBe(false);
    expect(
      provider.canTransfer({ id: "x", metadata: { callSid: "CA1", telephony: "sip" } }),
    ).toBe(false);
  });

  it("reports a missing destination rather than calling the API", async () => {
    const provider = createTwilioTransferProvider({ accountSid: "AC1", authToken: "t" });
    const result = await provider.transfer(twilioSession(), { to: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no destination");
  });

  it("reports a non-transferable session", async () => {
    const provider = createTwilioTransferProvider({ accountSid: "AC1", authToken: "t" });
    const result = await provider.transfer({ id: "x", metadata: {} }, { to: "+15551234567" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a transferable");
  });

  it("applies redirect TwiML to the live call", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new TwilioTransferProvider({ accountSid: "AC1", authToken: "t" });
    const result = await provider.transfer(twilioSession(), {
      to: "+15551234567",
      context: { reason: "escalation" },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/Accounts/AC1/Calls/CA123.json");
    expect(String(init.body)).toContain("Twiml=");
    expect(String(init.body)).toContain(encodeURIComponent("reason"));

    vi.unstubAllGlobals();
  });

  it("surfaces an API rejection instead of claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad request" })),
    );

    const provider = new TwilioTransferProvider({ accountSid: "AC1", authToken: "t" });
    const result = await provider.transfer(twilioSession(), { to: "+15551234567" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    vi.unstubAllGlobals();
  });

  it("surfaces a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }),
    );

    const provider = new TwilioTransferProvider({ accountSid: "AC1", authToken: "t" });
    const result = await provider.transfer(twilioSession(), { to: "+15551234567" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
    vi.unstubAllGlobals();
  });
});

describe("staged transfers in the pipeline", () => {
  it("runs the transfer only after the reply has been spoken", async () => {
    const { VoicePipeline } = await import("../src/pipeline.js");
    const { JEVEngine } = await import("../src/jev/engine.js");
    const { FastSemanticEmbeddingProvider } = await import("../src/jev/fast-embeddings.js");
    const { ConversationMemory } = await import("../src/memory/context.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");
    const { CallLogger } = await import("../src/analytics/logger.js");
    const { EnergyVAD } = await import("../src/vad/energy.js");

    const order: string[] = [];
    let staged: { to: string } | null = null;

    const jev = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await jev.initialize([
      {
        id: "escalate",
        description: "Escalate to a human supervisor",
        handler: async (ctx) => {
          ctx.transfer?.({ to: "+15551234567", message: "connecting you" });
          staged = { to: "+15551234567" };
          order.push("handler");
          return "Let me get a colleague.";
        },
      },
    ]);

    // The stream must actually deliver a final transcript, otherwise the turn
    // is empty and never reaches the handler.
    let onResult: ((r: { text: string; isFinal: boolean; confidence: number }) => void) | null =
      null;
    const stt = {
      name: "m",
      createStream: () => ({
        write() {},
        onResult(handler: (r: { text: string; isFinal: boolean; confidence: number }) => void) {
          onResult = handler;
        },
        async close() {},
        async flush() {
          onResult?.({ text: "I want a manager please", isFinal: true, confidence: 0.9 });
        },
      }),
    };

    const pipeline = new VoicePipeline({
      sessionId: "s",
      session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
      stt: stt as never,
      tts: {
        name: "t",
        async *synthesize() {
          order.push("tts");
          yield { data: Buffer.alloc(2), sampleRate: 16000, channels: 1, bitDepth: 16, timestampMs: 0 };
        },
      },
      vad: new EnergyVAD(),
      jev,
      memory: new ConversationMemory(),
      tools: new ToolRegistry(),
      logger: new CallLogger(),
      hooks: {},
      systemPrompt: "",
      sendAudio: async () => {},
      transferProvider: {
        name: "test",
        canTransfer: () => true,
        transfer: async (_session, request) => {
          order.push("transfer");
          return { success: true, mode: request.mode ?? "cold", to: request.to };
        },
      },
    });

    await pipeline.start();

    const events: string[] = [];
    pipeline.on("transferred", () => events.push("transferred"));

    // Drive a turn.
    const stream = (pipeline as unknown as { sttStream: { flush(): Promise<void> } }).sttStream;
    await stream.flush();
    await (pipeline as unknown as { handleUserTurnComplete(): Promise<void> })
      .handleUserTurnComplete();
    await new Promise((r) => setTimeout(r, 50));

    // The transfer must come after the TTS, or the caller never hears the intro.
    expect(order).toEqual(["handler", "tts", "transfer"]);
    expect(staged).not.toBeNull();
    expect(events).toContain("transferred");

    await pipeline.stop();
  });
});

describe("CallSupervisor", () => {
  const session: Session = {
    id: "s1",
    startedAt: new Date(),
    metadata: {},
    state: "active",
  };
  const transport: Transport = {
    start: async () => {},
    stop: async () => {},
    onAudioChunk() {},
    onConnect() {},
    onDisconnect() {},
    sendAudio: async () => {},
  };

  const build = () =>
    new CallSupervisor("s1", { transport, resolveSession: () => session });

  const chunk: AudioChunk = {
    data: Buffer.alloc(2),
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    timestampMs: 0,
  };

  it("starts with the agent on the floor", () => {
    const sup = build();
    expect(sup.state).toBe("agent");
    expect(sup.isAgentSpeaking).toBe(true);
    expect(sup.shouldForwardAgentAudio()).toBe(true);
  });

  it("forwards audio to an attached supervisor", () => {
    const sup = build();
    const seen: AudioChunk[] = [];
    sup.attach({ sessionId: "s1", state: "agent", onAudio: (c) => seen.push(c) });

    sup.listen(chunk);
    expect(seen).toHaveLength(1);
  });

  it("drops audio when no supervisor is listening", () => {
    const sup = build();
    expect(() => sup.listen(chunk)).not.toThrow();
  });

  it("hands the floor to the supervisor on takeover", () => {
    const sup = build();
    sup.takeover("customer angry");

    expect(sup.state).toBe("supervisor");
    expect(sup.shouldForwardAgentAudio()).toBe(false);
  });

  it("mutes the agent but keeps the call alive", () => {
    const sup = build();
    sup.mute();

    expect(sup.state).toBe("muted");
    expect(sup.shouldForwardAgentAudio()).toBe(false);
  });

  it("returns control to the agent", () => {
    const sup = build();
    sup.takeover();
    sup.release();
    expect(sup.state).toBe("agent");
  });

  it("speaks as the supervisor and returns the floor afterwards", async () => {
    const sup = build();
    const spoken: string[] = [];
    sup.attach({
      sessionId: "s1",
      state: "agent",
      speak: (text) => {
        spoken.push(text);
      },
    });

    const ok = await sup.speak("Hello, I can help with that.");

    expect(ok).toBe(true);
    expect(spoken).toEqual(["Hello, I can help with that."]);
    // Critically: the agent resumes, so the call is not left silent.
    expect(sup.state).toBe("agent");
  });

  it("stays with the supervisor after a takeover even once they finish speaking", async () => {
    const sup = build();
    sup.attach({ sessionId: "s1", state: "agent", speak: () => {} });
    sup.takeover();

    await sup.speak("I am handling this now.");

    // Takeover is explicit, so control does not silently drift back.
    expect(sup.state).toBe("supervisor");
  });

  it("reports a missing voice channel instead of pretending to speak", async () => {
    const sup = build();
    const ok = await sup.speak("anything");
    expect(ok).toBe(false);
  });

  it("delivers whispers to the supervisor only", () => {
    const sup = build();
    const events: string[] = [];
    sup.on((e) => {
      if (e.type === "whisper") events.push(e.message);
    });

    expect(sup.whisper("offer the refund", { orderId: "ACM-1" })).toBe(true);
    expect(events).toEqual(["offer the refund"]);
  });

  it("ends the call and refuses further control", () => {
    const sup = build();
    sup.end();

    expect(sup.state).toBe("ended");
    expect(sup.takeover()).toBe(false);
    expect(sup.mute()).toBe(false);
    expect(sup.whisper("too late")).toBe(false);
    expect(() => sup.attach({ sessionId: "s1", state: "agent" })).toThrow(/ended/);
  });

  it("survives a throwing listener", () => {
    const sup = build();
    sup.on(() => {
      throw new Error("bad listener");
    });
    expect(() => sup.mute()).not.toThrow();
  });
});

describe("support preset escalation", () => {
  it("does not claim a handoff when no transfer is configured", async () => {
    const agent = createSupportAgent().build();
    const reply = await agent.interact("let me speak to a manager");

    expect(reply.action.id).toBe("escalate_supervisor");
    // The honesty fix: no false promise of a connection.
    expect(reply.text.toLowerCase()).not.toContain("connecting you");
    expect(reply.text.toLowerCase()).toContain("not connected to a transfer service");
  });
});

describe("transfer tracing", () => {
  it("wraps the handover in a felona.transfer span", async () => {
    const { VoicePipeline } = await import("../src/pipeline.js");
    const { JEVEngine } = await import("../src/jev/engine.js");
    const { FastSemanticEmbeddingProvider } = await import("../src/jev/fast-embeddings.js");
    const { ConversationMemory } = await import("../src/memory/context.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");
    const { CallLogger } = await import("../src/analytics/logger.js");
    const { EnergyVAD } = await import("../src/vad/energy.js");
    const { FelonaTracer, SPAN } = await import("../src/observability/tracing.js");

    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const tracer = {
      startSpan: (name: string) => makeSpan(spans, name).span,
      startActiveSpan: (name: string, a?: unknown, b?: unknown) => {
        const fn = (b ?? a) as (x: never) => unknown;
        const made = makeSpan(spans, String(name));
        const opts = (b ? a : undefined) as { attributes?: Record<string, unknown> } | undefined;
        if (opts?.attributes) Object.assign(made.record.attributes, opts.attributes);
        return fn(made.span as never);
      },
    } as never;

    const jev = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
    await jev.initialize([
      {
        id: "escalate",
        description: "Escalate to a human supervisor",
        handler: async (ctx) => {
          ctx.transfer?.({ to: "+15551234567", message: "connecting you" });
          return "Let me get a colleague.";
        },
      },
    ]);

    let onResult: ((r: { text: string; isFinal: boolean; confidence: number }) => void) | null = null;
    const stt = {
      name: "m",
      createStream: () => ({
        write() {},
        onResult(handler: (r: { text: string; isFinal: boolean; confidence: number }) => void) {
          onResult = handler;
        },
        async close() {},
        async flush() {
          onResult?.({ text: "I want a manager please", isFinal: true, confidence: 0.9 });
        },
      }),
    };

    const pipeline = new VoicePipeline({
      sessionId: "s",
      session: { id: "s", startedAt: new Date(), metadata: {}, state: "active" },
      stt: stt as never,
      tts: {
        name: "t",
        async *synthesize() {
          yield { data: Buffer.alloc(2), sampleRate: 16000, channels: 1, bitDepth: 16, timestampMs: 0 };
        },
      } as never,
      vad: new EnergyVAD({ hangoverMs: 60, minSpeechMs: 10 }),
      jev,
      memory: new ConversationMemory(),
      tools: new ToolRegistry(),
      logger: new CallLogger(),
      hooks: {},
      systemPrompt: "test",
      sendAudio: async () => undefined,
      tracer: new FelonaTracer({ tracer }),
      transferProvider: {
        canTransfer: () => true,
        transfer: async () => ({ success: true, mode: "warm", to: "+15551234567" }),
      } as never,
    });

    await pipeline.start();

    // Drive the turn directly, as the test above does: feeding silence would
    // never trip the VAD, and this is about the span, not about endpointing.
    const stream = (pipeline as unknown as { sttStream: { flush(): Promise<void> } }).sttStream;
    await stream.flush();
    await (pipeline as unknown as { handleUserTurnComplete(): Promise<void> })
      .handleUserTurnComplete();
    await new Promise((r) => setTimeout(r, 50));
    await pipeline.stop();

    const transfer = spans.find((x) => x.name === SPAN.transfer);
    expect(transfer).toBeDefined();
    expect(transfer!.attributes).toMatchObject({
      "felona.transfer.to": "+15551234567",
      "felona.transfer.ok": true,
    });
  });
});

/** Minimal recording span, mirroring the harness in pipeline-turns.test.ts. */
function makeSpan(
  spans: Array<{ name: string; attributes: Record<string, unknown> }>,
  name: string,
) {
  const record = { name: String(name), attributes: {} as Record<string, unknown> };
  spans.push(record);
  const spanContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  const span = {
    spanContext: () => spanContext,
    setAttribute: (k: string, v: unknown) => {
      record.attributes[k] = v;
      return span;
    },
    setAttributes: (a: Record<string, unknown>) => {
      Object.assign(record.attributes, a);
      return span;
    },
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: () => span,
    updateName: () => span,
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined,
  };
  return { span, record };
}
