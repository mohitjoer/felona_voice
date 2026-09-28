/**
 * Shared HTTP endpoints for transports that open their own server.
 *
 * Each transport previously served (or omitted) these independently, so
 * `/health` existed on exactly one of them. A process that only speaks
 * WebSocket or WebRTC had no way to answer a liveness probe, and no way to
 * expose call metrics without writing a bespoke server.
 *
 * Deliberately unauthenticated and free of call content: a probe must work
 * before credentials are wired up, and it must not leak transcripts or phone
 * numbers. It reports counts and process state only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MetricsRegistry } from "../observability/metrics.js";

/** State a transport reports about itself. */
export interface HealthState {
  /** Provider name, e.g. "twilio" or "websocket". */
  provider: string;
  /** Live sessions this transport is holding. */
  activeCalls: number;
  /** Maximum concurrent calls, when the transport enforces one. */
  maxConnections?: number;
}

/** Options for {@link createOpsHandler}. */
export interface OpsHandlerOptions {
  /** Registry to scrape. Omit to serve an empty metrics body. */
  metrics?: MetricsRegistry;
  /** Supplies current state. Called per request so counts are live. */
  getState: () => HealthState;
  /** Set false to refuse the health endpoint, e.g. to avoid leaking volume. */
  exposeHealth?: boolean;
}

/**
 * Returns a request handler for `/health` and `/metrics`.
 *
 * Returns `undefined` when no endpoint is exposed, so the caller can pass it
 * straight through to a server that has nothing to serve.
 */
export function createOpsHandler(
  options: OpsHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined {
  const { metrics, getState, exposeHealth = true } = options;

  if (!exposeHealth && !metrics) return undefined;

  return (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    // Returns whether the request was handled, so a caller can chain its own
    // routes on the same server.

    if (exposeHealth && (pathname === "/health" || pathname === "/")) {
      const state = getState();
      // 503 when at capacity: a load balancer should stop sending traffic here
      // rather than queue calls this process cannot serve.
      const atCapacity =
        state.maxConnections !== undefined && state.activeCalls >= state.maxConnections;
      const body = JSON.stringify(
        {
          status: atCapacity ? "degraded" : "ok",
          provider: state.provider,
          activeCalls: state.activeCalls,
          ...(state.maxConnections !== undefined
            ? { maxConnections: state.maxConnections }
            : {}),
          uptimeSeconds: Math.round(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        null,
        2,
      );
      res.writeHead(atCapacity ? 503 : 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return true;
    }

    if (metrics && pathname === "/metrics") {
      const body = metrics.render();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return true;
    }

    // Not ours — let the caller keep the connection.
    return false;
  };
}
