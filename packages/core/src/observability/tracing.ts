/**
 * OpenTelemetry tracing for call pipelines.
 *
 * Built on the OpenTelemetry *API* only. That package contains no SDK, so when
 * an application has not registered a tracer provider every call here resolves
 * to a no-op and costs a function call. An application that does want traces
 * installs an SDK and exporter, and this module starts emitting without any
 * change to Felona's own configuration.
 *
 * ## What is deliberately not recorded
 *
 * Spans are exported and stored by whatever backend the operator chose, often
 * for far longer than the call. Transcript text therefore never appears in a
 * span attribute. Turns are identified by a short SHA-256 fingerprint, which
 * still lets you group identical turns across a trace, plus a character count.
 * Putting the caller's words in a span would turn a debugging tool into a
 * transcript archive that outlives the session — and Felona holds conversation
 * state in memory only, by design.
 *
 * A `felona.turn.fingerprint` is a hash, not an encoding, so it is not a way to
 * recover the text. If you need the content, log it deliberately in your own
 * hook, where you control retention.
 */

import {
  context as otelContext,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { createHash } from "node:crypto";

/** Instrumentation scope reported to OpenTelemetry. */
export const TRACER_NAME = "felona-voice";
export const TRACER_VERSION = "0.2.5";

/**
 * Span names for the stages of a turn.
 *
 * Grouped by the subsystem that owns them so `felona.jev.decide` filters to
 * every routing decision regardless of transport.
 */
export const SPAN = {
  /** A whole caller turn: transcript in, audio out. */
  turn: "felona.turn",
  /** A turn computed ahead of time while the caller was still speaking. */
  preemptiveTurn: "felona.turn.preemptive",
  /** Waiting on the recogniser for a final transcript. */
  sttFinalize: "felona.stt.finalize",
  /** A transcript event from the streaming recogniser. */
  sttResult: "felona.stt.result",
  /** JEV predicting the next action. */
  jevDecide: "felona.jev.decide",
  /** An action handler producing its reply. */
  actionHandler: "felona.action.handle",
  /** Text-to-speech synthesis and playback. */
  ttsSpeak: "felona.tts.speak",
  /** A tool invoked by a handler. */
  toolCall: "felona.tool.call",
  /** Handing the call to a human. */
  transfer: "felona.transfer",
  /** The call ending and its analysis running. */
  callEnd: "felona.call.end",
} as const;

export type SpanName = (typeof SPAN)[keyof typeof SPAN];

/**
 * A short, stable identifier for a piece of text.
 *
 * Grouping turns by fingerprint answers "did this exact phrasing come up
 * again?" without the trace holding the phrasing itself.
 */
export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface FelonaTracerOptions {
  /**
   * Tracer to use. Defaults to the global OpenTelemetry tracer, which is a
   * no-op until the application registers a provider. Injecting one is how the
   * tests assert on spans without standing up an SDK.
   */
  tracer?: Tracer;
  /** Instrumentation scope name. Default: `felona-voice`. */
  name?: string;
  /** Instrumentation scope version. Default: the framework version. */
  version?: string;
}

/**
 * Thin wrapper over an OpenTelemetry tracer.
 *
 * Exists to give the pipeline one place that knows how a span is created, how
 * failures are recorded, and what may go into attributes — so those rules are
 * enforced once rather than at every call site.
 */
export class FelonaTracer {
  private readonly tracer: Tracer;

  constructor(options: FelonaTracerOptions = {}) {
    this.tracer =
      options.tracer ??
      trace.getTracer(options.name ?? TRACER_NAME, options.version ?? TRACER_VERSION);
  }

  /** The underlying tracer, for interoperating with other instrumentation. */
  get raw(): Tracer {
    return this.tracer;
  }

  /**
   * Run `fn` inside a span, recording its duration and outcome.
   *
   * A throw is recorded on the span and re-thrown unchanged: tracing observes
   * the call, it never swallows it or changes what the caller sees. The span is
   * ended on both paths.
   */
  async span<T>(
    name: SpanName | string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T> | T,
  ): Promise<T> {
    // `startActiveSpan` keeps the span current for anything downstream that
    // creates its own spans or injects trace headers, which is what stitches a
    // Felona turn to an STT or LLM call made inside a handler.
    return this.tracer.startActiveSpan(
      name,
      { attributes },
      async (span: Span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });
          // recordException is what attaches the stack trace to the span.
          span.recordException(err);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Start a span that is ended by the caller.
   *
   * For work whose lifetime does not match a single `await` — a call that stays
   * open while the agent speaks.
   */
  startSpan(name: SpanName | string, attributes: Attributes = {}): Span {
    return this.tracer.startSpan(name, { attributes });
  }

  /** The current active context, for propagation into other systems. */
  get activeContext(): Context {
    return otelContext.active();
  }

  /**
   * Inject the active trace context into a carrier for an outgoing request.
   *
   * Use this when a handler calls out to a service that is also instrumented,
   * so the work it does appears under the caller's turn instead of as an
   * unrelated trace.
   */
  injectContext(carrier: Record<string, string>): Record<string, string> {
    propagation.inject(otelContext.active(), carrier);
    return carrier;
  }
}

export function createFelonaTracer(
  options: FelonaTracerOptions = {},
): FelonaTracer {
  return new FelonaTracer(options);
}

/**
 * A compact trace/span reference for log lines, or an empty string when
 * nothing is recording.
 *
 * Passing the pair by hand into a log formatter is what makes a stack trace in
 * a log viewer jump to the matching trace, so it is worth doing at the points
 * where a call can go wrong.
 */
export function formatTraceContext(span?: Span): string {
  const active = span ?? trace.getSpan(otelContext.active());
  if (!active) return "";
  const traceId = active.spanContext().traceId;
  const spanId = active.spanContext().spanId;
  if (!traceId || !spanId) return "";
  return ` [trace=${traceId} span=${spanId}]`;
}

/**
 * Run `fn` with `attributes` merged into a span.
 *
 * Used for a stage that belongs to whichever turn is already in flight — the
 * transcript callback, say — where there is no `await` of its own to wrap.
 */
export function withAttributes<T>(
  span: Span,
  attributes: Attributes,
  fn: () => T,
): T {
  span.setAttributes(attributes);
  return fn();
}
