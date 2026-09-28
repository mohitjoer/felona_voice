import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { MetricsRegistry, registerCallMetrics } from "../src/observability/metrics.js";
import { createOpsHandler } from "../src/transport/ops.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Captures what a handler wrote, without needing a real socket. */
function fakeRes() {
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      res.body = chunks.join("");
      return res;
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

function fakeReq(url: string): IncomingMessage {
  return { url, headers: {}, method: "GET" } as unknown as IncomingMessage;
}

describe("MetricsRegistry", () => {
  it("increments and reads counters", () => {
    const m = new MetricsRegistry();
    m.increment("calls_total");
    m.increment("calls_total", 2);
    expect(m.get("calls_total")).toBe(3);
  });

  it("sets and adjusts gauges independently of counters", () => {
    const m = new MetricsRegistry();
    m.addGauge("active", 1);
    m.addGauge("active", 1);
    m.addGauge("active", -1);
    expect(m.get("active")).toBe(1);
  });

  it("keeps labelled series separate", () => {
    const m = new MetricsRegistry();
    m.increment("errors_total", 1, { provider: "deepgram" });
    m.increment("errors_total", 1, { provider: "openai" });
    m.increment("errors_total", 1, { provider: "deepgram" });
    expect(m.get("errors_total", { provider: "deepgram" })).toBe(2);
    expect(m.get("errors_total", { provider: "openai" })).toBe(1);
  });

  it("renders the Prometheus text format", () => {
    const m = new MetricsRegistry();
    m.describe("felona_calls_total", "Calls handled");
    m.increment("felona_calls_total", 5);
    const out = m.render();
    expect(out).toContain("# HELP felona_calls_total Calls handled");
    expect(out).toContain("# TYPE felona_calls_total counter");
    expect(out).toContain("felona_calls_total 5");
  });

  it("renders labels and escapes hostile values", () => {
    const m = new MetricsRegistry();
    m.increment("e", 1, { provider: 'we"ird\nvalue' });
    const out = m.render();
    // A raw quote or newline would break the exposition format.
    expect(out).toContain('provider="we\\"ird\\nvalue"');
    expect(out.split("\n").filter((l) => l.startsWith("e{")).length).toBe(1);
  });


  it("registers the standard call metrics", () => {
    const m = new MetricsRegistry();
    registerCallMetrics(m);
    const out = m.render();
    for (const name of [
      "felona_calls_started_total",
      "felona_calls_active",
      "felona_turns_total",
      "felona_stt_errors_total",
    ]) {
      // Names are described even before any sample is recorded, so a scraper
      // sees a stable series from the first request.
      expect(out).toContain(`# HELP ${name}`);
    }
  });

  it("resets", () => {
    const m = new MetricsRegistry();
    m.increment("x");
    m.reset();
    expect(m.get("x")).toBe(0);
  });
});

describe("ops endpoints", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("serves health JSON with live counts", () => {
    let active = 3;
    const handler = createOpsHandler({
      getState: () => ({ provider: "twilio", activeCalls: active }),
    })!;
    const res = fakeRes();
    handler(fakeReq("/health"), res);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("twilio");
    expect(body.activeCalls).toBe(3);
    // Counted live, not snapshotted at handler creation.
    active = 9;
    const res2 = fakeRes();
    handler(fakeReq("/health"), res2);
    expect(JSON.parse(res2.body).activeCalls).toBe(9);
  });

  it("reports 503 at capacity so a balancer backs off", () => {
    const handler = createOpsHandler({
      getState: () => ({ provider: "ws", activeCalls: 10, maxConnections: 10 }),
    })!;
    const res = fakeRes();
    handler(fakeReq("/health"), res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).status).toBe("degraded");
  });

  it("serves metrics in the Prometheus format", () => {
    const m = new MetricsRegistry();
    m.increment("felona_calls_started_total", 7);
    const handler = createOpsHandler({
      metrics: m,
      getState: () => ({ provider: "ws", activeCalls: 0 }),
    })!;
    const res = fakeRes();
    handler(fakeReq("/metrics"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("felona_calls_started_total 7");
  });

  it("declines paths it does not own, so a caller can chain routes", () => {
    const handler = createOpsHandler({
      getState: () => ({ provider: "ws", activeCalls: 0 }),
    })!;
    const res = fakeRes();
    // Returning false matters: a shared server must still serve its own routes.
    expect(handler(fakeReq("/voice"), res)).toBe(false);
  });

  it("can be disabled entirely", () => {
    expect(createOpsHandler({ exposeHealth: false, getState: () => ({ provider: "x", activeCalls: 0 }) })).toBeUndefined();
  });

  it("does not leak call content", () => {
    const handler = createOpsHandler({
      getState: () => ({ provider: "twilio", activeCalls: 2 }),
    })!;
    const res = fakeRes();
    handler(fakeReq("/health"), res);
    // No transcripts, no phone numbers — counts and process state only.
    expect(res.body).not.toMatch(/\+\d{7,}/);
    expect(res.body).not.toMatch(/transcript/i);
  });
});
