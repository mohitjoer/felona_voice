/**
 * Call metrics.
 *
 * A voice deployment cannot be operated from traces alone: the questions that
 * matter at 3am are how many calls are live, how often a turn is dropped, and
 * whether a provider is failing. Those are counters and gauges, not spans.
 *
 * The registry is dependency-free and push-based. `render()` emits the
 * Prometheus text format, which is what a scraper expects, but the counters
 * are also directly readable so an application can forward them to whatever
 * backend it already runs.
 */

/** A single named counter or gauge. */
export interface MetricSample {
  name: string;
  value: number;
  /** Optional labels, rendered as Prometheus label pairs. */
  labels?: Record<string, string>;
  help?: string;
  type?: "counter" | "gauge";
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly help = new Map<string, string>();
  private readonly types = new Map<string, "counter" | "gauge">();

  /** Increments a counter. */
  increment(name: string, value = 1, labels?: Record<string, string>): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    this.recordType(name, "counter");
  }

  /** Adds to a gauge, e.g. a live-connection count going up and down. */
  addGauge(name: string, delta: number, labels?: Record<string, string>): void {
    const key = labelKey(name, labels);
    this.gauges.set(key, (this.gauges.get(key) ?? 0) + delta);
    this.recordType(name, "gauge");
  }

  /** Reads a single sample, preferring a gauge over a counter. */
  get(name: string, labels?: Record<string, string>): number {
    const key = labelKey(name, labels);
    return this.gauges.get(key) ?? this.counters.get(key) ?? 0;
  }

  /** Every recorded sample. */
  samples(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const [key, value] of this.counters) {
      const { name, labels } = parseKey(key);
      out.push({
        name,
        value,
        labels,
        help: this.help.get(name),
        type: "counter",
      });
    }
    for (const [key, value] of this.gauges) {
      const { name, labels } = parseKey(key);
      out.push({
        name,
        value,
        labels,
        help: this.help.get(name),
        type: "gauge",
      });
    }
    return out;
  }

  private recordType(name: string, type: "counter" | "gauge"): void {
    this.types.set(name, type);
  }

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  /** Clears all samples. Intended for tests. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }

  /**
   * Renders the Prometheus text exposition format.
   *
   * A described metric with no samples is emitted as `0`, so a scraper sees a
   * stable series from the first request instead of a metric that appears only
   * after the first call — which reads as "no data" rather than "zero".
   *
   * Label values are escaped, so a provider name or session id containing a
   * quote or newline cannot corrupt the output.
   */
  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, MetricSample[]>();
    for (const sample of this.samples()) {
      const bucket = byName.get(sample.name) ?? [];
      bucket.push(sample);
      byName.set(sample.name, bucket);
    }
    // Include described metrics that have not recorded a sample yet.
    for (const name of this.help.keys()) {
      if (!byName.has(name)) byName.set(name, []);
    }

    for (const [name, group] of byName) {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${this.types.get(name) ?? "gauge"}`);
      if (group.length === 0) {
        lines.push(`${name} 0`);
        continue;
      }
      for (const sample of group) {
        lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
      }
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
}

function labelKey(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

function parseKey(key: string): { name: string; labels?: Record<string, string> } {
  const brace = key.indexOf("{");
  if (brace === -1) return { name: key };
  const name = key.slice(0, brace);
  const inner = key.slice(brace + 1, key.lastIndexOf("}"));
  const labels: Record<string, string> = {};
  for (const pair of inner.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(labels).length ? { name, labels } : { name };
}

function renderLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  const parts = Object.keys(labels)
    .sort()
    .map(
      (k) =>
        `${k}="${String(labels[k])
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")}"`,
    );
  return `{${parts.join(",")}}`;
}

/**
 * Registers the standard call metrics on a registry.
 *
 * Names are `felona_`-prefixed so they cannot collide with an application's
 * own instrumentation in a shared Prometheus namespace.
 */
export function registerCallMetrics(registry: MetricsRegistry): void {
  registry.describe("felona_calls_started_total", "Calls accepted by the agent");
  registry.describe("felona_calls_ended_total", "Calls torn down");
  registry.describe("felona_calls_active", "Calls currently in progress");
  registry.describe("felona_calls_rejected_total", "Calls refused, e.g. at capacity");
  registry.describe("felona_calls_timed_out_total", "Calls ended by the duration limit");
  registry.describe("felona_turns_total", "Turns routed through JEV");
  registry.describe("felona_turns_abandoned_total", "Turns dropped because the caller interrupted");
  registry.describe("felona_guardrail_blocks_total", "Turns blocked by a guardrail, by side");
  registry.describe("felona_llm_prompt_tokens_total", "LLM prompt tokens consumed");
  registry.describe("felona_llm_completion_tokens_total", "LLM completion tokens consumed");
  registry.describe("felona_call_cost_usd_total", "Estimated spend across all calls, in USD");
  registry.describe("felona_voicemail_detected_total", "Calls ended because an answering machine was detected");
  registry.describe("felona_turn_errors_total", "Turns that failed");
  registry.describe("felona_stt_errors_total", "Speech-to-text errors, by provider");
  registry.describe("felona_tts_errors_total", "Text-to-speech errors, by provider");
  registry.describe("felona_barge_ins_total", "Caller interruptions");
}

/** Process-wide default registry. */
export const defaultMetrics = new MetricsRegistry();
