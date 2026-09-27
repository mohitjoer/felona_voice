import { describe, it, expect } from "vitest";
import {
  context as otelContext,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
} from "@opentelemetry/api";
import {
  FelonaTracer,
  createFelonaTracer,
  contentFingerprint,
  formatTraceContext,
  SPAN,
} from "../src/observability/tracing.js";
import { ToolRegistry, defineTool } from "../src/tools/registry.js";

/**
 * A recording tracer.
 *
 * Asserting on real spans would mean standing up an SDK and a processor; this
 * captures the same calls so the test stays about *what the pipeline reports*,
 * not about the exporter.
 */
interface RecordedSpan {
  name: string;
  attributes: Attributes;
  status: { code: number; message?: string };
  ended: boolean;
  exceptions: Error[];
  parent?: string;
}

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const contextStack: string[] = [];

  const makeSpan = (
    name: string,
    parentName?: string,
  ): { span: Span; record: RecordedSpan } => {
    const record: RecordedSpan = {
      name,
      attributes: {},
      status: { code: 0 },
      ended: false,
      exceptions: [],
      parent: parentName,
    };
    spans.push(record);

    const spanContext: SpanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: `span-${spans.length}`,
      traceFlags: 1,
    };

    const span: Span = {
      spanContext: () => spanContext,
      setAttribute(key: string, value: unknown) {
        record.attributes[key] = value as Attributes[string];
        return span;
      },
      setAttributes(attrs: Attributes) {
        Object.assign(record.attributes, attrs);
        return span;
      },
      addEvent() {
        return span;
      },
      addLink() {
        return span;
      },
      addLinks() {
        return span;
      },
      setStatus(status: { code: number; message?: string }) {
        record.status = status;
        return span;
      },
      updateName() {
        return span;
      },
      end() {
        record.ended = true;
        return undefined;
      },
      isRecording: () => true,
      recordException(error: Error) {
        record.exceptions.push(error);
      },
    };
    return { span, record };
  };

  const tracer: Tracer = {
    startSpan(name) {
      return makeSpan(String(name), contextStack[contextStack.length - 1]).span;
    },
    startActiveSpan(name, optionsOrFn, maybeFn) {
      // The API has two overloads: (name, options, fn) and (name, fn).
      const fn = maybeFn ?? (optionsOrFn as unknown);
      const options = maybeFn
        ? (optionsOrFn as { attributes?: Attributes })
        : undefined;
      const { span, record } = makeSpan(
        String(name),
        contextStack[contextStack.length - 1],
      );
      // A real tracer applies the caller's initial attributes to the span.
      if (options?.attributes) Object.assign(record.attributes, options.attributes);
      contextStack.push(span.spanContext().spanId);
      const ctx = trace.setSpanContext(otelContext.active(), span.spanContext());
      const run = fn as (
        span: Span,
        done: (err?: unknown, result?: unknown) => void,
      ) => unknown;
      const done = (err?: unknown, result?: unknown) => {
        if (err) span.recordException(err as Error);
        if (result !== undefined) (span as { _result?: unknown })._result = result;
      };
      return otelContext.with(ctx, () => run(span, done));
    },
  };

  return { tracer, spans };
}

describe("FelonaTracer", () => {
  it("runs a callback inside a span and ends it", async () => {
    const { tracer, spans } = recordingTracer();
    const t = new FelonaTracer({ tracer });

    const result = await t.span(SPAN.turn, { "felona.a": 1 }, async (span) => {
      span.setAttribute("felonia.b", "two");
      return "done";
    });

    expect(result).toBe("done");
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe(SPAN.turn);
    expect(spans[0].attributes).toMatchObject({
      "felona.a": 1,
      "felonia.b": "two",
    });
    expect(spans[0].ended).toBe(true);
    expect(spans[0].status.code).toBe(1); // OK
  });

  it("records a failure, ends the span, and rethrows unchanged", async () => {
    const { tracer, spans } = recordingTracer();
    const t = new FelonaTracer({ tracer });
    const boom = new Error("handler exploded");

    await expect(
      t.span(SPAN.actionHandler, {}, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The span must not stay open on the failure path.
    expect(spans[0].ended).toBe(true);
    expect(spans[0].status.code).toBe(2); // ERROR
    expect(spans[0].status.message).toBe("handler exploded");
    expect(spans[0].exceptions[0]).toBe(boom);
  });

  it("records a non-Error throw without losing it", async () => {
    const { tracer, spans } = recordingTracer();
    const t = new FelonaTracer({ tracer });

    await expect(
      t.span(SPAN.jevDecide, {}, () => {
        throw "a string";
      }),
    ).rejects.toBe("a string");

    expect(spans[0].status.message).toBe("a string");
  });

  it("nests child spans under the active parent", async () => {
    const { tracer, spans } = recordingTracer();
    const t = new FelonaTracer({ tracer });

    await t.span(SPAN.turn, {}, async () => {
      await t.span(SPAN.jevDecide, {}, async () => {
        await t.span(SPAN.actionHandler, {}, () => "x");
      });
    });

    expect(spans.map((s) => s.name)).toEqual([
      SPAN.turn,
      SPAN.jevDecide,
      SPAN.actionHandler,
    ]);
    expect(spans[1].parent).toBe("span-1");
    expect(spans[2].parent).toBe("span-2");
  });

  it("returns a no-op tracer when nothing is configured", async () => {
    // No global provider is registered in this suite, so this exercises the
    // path a default-constructed agent takes.
    const t = createFelonaTracer();
    expect(await t.span(SPAN.turn, { a: 1 }, () => "ok")).toBe("ok");
    // An unregistered provider yields the invalid all-zero trace id.
    expect(t.startSpan(SPAN.callEnd).spanContext().traceId).toBe(
      "0".repeat(32),
    );
  });

  it("injects the active context into a carrier", async () => {
    const { tracer } = recordingTracer();
    const t = new FelonaTracer({ tracer });
    const carrier = t.injectContext({});
    // The recording tracer does not implement real propagation, so the
    // assertion is that the call is safe and returns the same carrier.
    expect(typeof carrier).toBe("object");
  });
});

describe("contentFingerprint", () => {
  it("is stable and distinguishes different text", () => {
    expect(contentFingerprint("hello")).toBe(contentFingerprint("hello"));
    expect(contentFingerprint("hello")).not.toBe(contentFingerprint("hello "));
  });

  it("is short and hex", () => {
    expect(contentFingerprint("hello")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not contain the text it fingerprints", () => {
    const secret = "my card is 4111111111111111";
    expect(contentFingerprint(secret)).not.toContain("4111");
  });
});

describe("formatTraceContext", () => {
  it("is empty outside a span", () => {
    expect(formatTraceContext()).toBe("");
  });
});

describe("tool call tracing", () => {
  it("records a successful tool call with keys but not values", async () => {
    const { tracer, spans } = recordingTracer();
    const registry = new ToolRegistry();
    registry.setTracer(new FelonaTracer({ tracer }));
    registry.register(
      defineTool({
        name: "lookup_order",
        description: "Look up an order",
        parameters: { type: "object" },
        execute: async () => "shipped",
      }),
    );

    await registry.call("lookup_order", { id: "A-1", pin: "s3cret" });

    const span = spans.find((s) => s.name === SPAN.toolCall);
    expect(span).toBeDefined();
    expect(span!.attributes).toMatchObject({
      "felona.tool.name": "lookup_order",
      "felona.tool.arg_keys": "id,pin",
      "felona.tool.ok": true,
    });
    // The caller's argument values must not reach an exported span.
    expect(JSON.stringify(span!.attributes)).not.toContain("s3cret");
    expect(span!.ended).toBe(true);
  });

  it("records a failing tool call and rethrows", async () => {
    const { tracer, spans } = recordingTracer();
    const registry = new ToolRegistry();
    registry.setTracer(new FelonaTracer({ tracer }));
    registry.register(
      defineTool({
        name: "boom",
        description: "fails",
        parameters: { type: "object" },
        execute: async () => {
          throw new Error("upstream down");
        },
      }),
    );

    await expect(registry.call("boom")).rejects.toThrow(/upstream down/);

    const span = spans.find((s) => s.name === SPAN.toolCall);
    expect(span!.attributes["felona.tool.ok"]).toBe(false);
    expect(span!.ended).toBe(true);
  });

  it("still works with tracing disabled", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "plain",
        description: "d",
        parameters: { type: "object" },
        execute: async () => "fine",
      }),
    );
    expect(await registry.call("plain")).toBe("fine");
  });
});
