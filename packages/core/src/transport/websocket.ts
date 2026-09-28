import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { createOpsHandler } from "./ops.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Transport,
  TransportOptions,
  AudioChunk,
  Session,
} from "../types.js";

export interface WebSocketTransportOptions {
  /** WebSocket path to accept connections on. */
  path?: string;
  /**
   * Shared secret. Clients must connect with `?token=<value>` or an
   * `Authorization: Bearer <value>` header. Recommended for any deployment
   * that is not on a private network.
   */
  authToken?: string;
  /**
   * Custom connection check. Takes precedence over `authToken`.
   * Return false to reject the upgrade.
   */
  verifyClient?: (req: IncomingMessage) => boolean;
  /** Milliseconds between heartbeat pings. Default: 30000. 0 disables. */
  heartbeatIntervalMs?: number;
  /** Maximum accepted inbound message size in bytes. Default: 1MB. */
  maxPayloadBytes?: number;
  /** Maximum simultaneous connections. Default: Infinity. */
  maxConnections?: number;
  /**
   * Registry scraped by the transport's `/metrics` endpoint.
   * Omit to serve no metrics route.
   */
  metrics?: MetricsRegistry;
  /**
   * Serve `/health` on this transport's HTTP server. Default: true.
   * Set false when live call counts should not be reachable.
   */
  exposeHealth?: boolean;
}

interface SessionEntry {
  ws: WebSocket;
  session: Session;
  isAlive: boolean;
  format: { sampleRate: number; channels: number; bitDepth: number };
}

/**
 * WebSocketTransport — Handles real-time audio streaming over WebSocket.
 *
 * Protocol:
 * - Binary frames = raw PCM audio data
 * - JSON text frames = control messages (metadata, audio.config, etc.)
 *
 * This is the default transport. Additional transports can implement the same
 * `Transport` interface.
 */
export class WebSocketTransport extends EventEmitter implements Transport {
  /** Outbound socket backlog past which audio chunks are dropped (256KB). */
  private static readonly MAX_BUFFERED_BYTES = 256 * 1024;

  private wss: WebSocketServer | null = null;
  /**
   * HTTP server carrying `/health` and `/metrics`.
   *
   * The WebSocket server alone cannot answer an HTTP probe, so this process
   * previously had no liveness endpoint at all.
   */
  private httpServer: Server | null = null;
  private ownsHttpServer = false;
  private sessions: Map<string, SessionEntry> = new Map();
  private options: WebSocketTransportOptions = {};
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private audioHandler:
    | ((sessionId: string, chunk: AudioChunk) => void)
    | null = null;
  private connectHandler: ((session: Session) => void) | null = null;
  private disconnectHandler: ((session: Session) => void) | null = null;

  constructor(options?: WebSocketTransportOptions) {
    super();
    this.options = { ...this.options, ...options };
  }

  /** Serves `/health` and `/metrics`. */
  private opsHandler?: (req: IncomingMessage, res: import("node:http").ServerResponse) => boolean;

  private buildOps(): void {
    this.opsHandler = createOpsHandler({
      metrics: this.options.metrics,
      exposeHealth: this.options.exposeHealth !== false,
      getState: () => ({
        provider: "websocket",
        activeCalls: this.sessions.size,
        maxConnections: this.options.maxConnections,
      }),
    });
  }

  async start(options: TransportOptions & { path?: string; server?: Server }): Promise<void> {
    const path = options.path ?? this.options.path;
    this.buildOps();

    // A caller-supplied server is how a deployment shares one port with its
    // own routes; the ops handler chains onto it rather than replacing it.
    if (options.server) {
      this.httpServer = options.server;
      this.ownsHttpServer = false;
      options.server.on("request", (req, res) => {
        if (this.opsHandler?.(req, res)) return;
      });
    } else if (this.opsHandler) {
      this.httpServer = http.createServer((req, res) => {
        if (this.opsHandler?.(req, res)) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
      this.ownsHttpServer = true;
    }

    return new Promise((resolve, reject) => {
      try {
        // Sharing the HTTP server when we own one keeps /health, /metrics and
        // the media path on a single port, which is what an orchestrator
        // expects to probe.
        const attachTo = options.server ?? (this.ownsHttpServer ? this.httpServer : undefined);
        this.wss = attachTo
          ? new WebSocketServer({
              server: attachTo,
              path,
              // Compressing PCM audio burns CPU for no meaningful size win.
              perMessageDeflate: false,
              maxPayload: this.options.maxPayloadBytes ?? 1024 * 1024,
              verifyClient: this.buildVerifyClient(),
            })
          : new WebSocketServer({
              port: options.port,
              host: options.host ?? "0.0.0.0",
              path,
              perMessageDeflate: false,
              maxPayload: this.options.maxPayloadBytes ?? 1024 * 1024,
              verifyClient: this.buildVerifyClient(),
            });

        this.wss.on("connection", (ws, req) => {
          if (
            this.options.maxConnections !== undefined &&
            this.sessions.size >= this.options.maxConnections
          ) {
            console.warn(
              `[Transport] Rejecting connection: ${this.sessions.size} sessions already active ` +
                `(max ${this.options.maxConnections})`,
            );
            ws.close(1013, "Server at capacity");
            return;
          }
          this.handleConnection(ws, req);
        });

        let started = false;
        this.wss.on("listening", () => {
          started = true;
          console.log(
            `[Transport] WebSocket server listening on ${options.host ?? "0.0.0.0"}:${options.port}${path ?? ""}`,
          );
          this.startHeartbeat();
          resolve();
        });

        if (this.ownsHttpServer && this.httpServer && !options.server) {
          this.httpServer.listen(options.port, options.host ?? "0.0.0.0");
        }

        this.wss.on("error", (error) => {
          // Before startup this must reject the pending promise; afterwards
          // there is nothing to settle, so surface it as an event instead of
          // an unhandled 'error' emission.
          if (!started) {
            reject(error);
            return;
          }
          this.emitTransportError(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * `error` is fatal on a bare EventEmitter, so it is only emitted when a
   * listener exists.
   */
  private emitTransportError(error: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
    } else {
      console.error("[Transport]", error.message);
    }
  }

  private buildVerifyClient():
    | ((info: { origin: string; secure: boolean; req: IncomingMessage }) => boolean)
    | undefined {
    const { authToken, verifyClient } = this.options;
    if (!verifyClient && !authToken) return undefined;

    return (info) => {
      const req = info.req;
      if (verifyClient) {
        try {
          return verifyClient(req);
        } catch {
          return false;
        }
      }

      const auth = req.headers.authorization;
      const bearer =
        typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
          ? auth.slice(7).trim()
          : "";

      let queryToken = "";
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        queryToken = url.searchParams.get("token") ?? "";
      } catch {
        return false;
      }

      const provided = bearer || queryToken;
      if (!provided || !authToken) return false;

      // Constant-time compare so the token cannot be recovered by timing.
      const a = Buffer.from(provided, "utf8");
      const b = Buffer.from(authToken, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    };
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 30_000;
    if (interval <= 0 || this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      for (const [, entry] of this.sessions) {
        if (!entry.isAlive) {
          // No pong since the last ping — the peer is gone.
          entry.ws.terminate();
          continue;
        }
        entry.isAlive = false;
        try {
          entry.ws.ping();
        } catch {
          entry.ws.terminate();
        }
      }
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Tears down one session, leaving the server and every other call running.
   */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Remove the entry before closing so the socket's own close handler does
    // not report a disconnect we are already handling.
    this.sessions.delete(sessionId);
    entry.session.state = "ended";
    this.disconnectHandler?.(entry.session);
    try {
      entry.ws.close();
    } catch {
      // Already closed.
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all active sessions
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId);
    }
    this.sessions.clear();

    // Shut down the server
    return new Promise((resolve) => {
      const done = () => {
        console.log("[Transport] WebSocket server stopped");
        resolve();
      };
      if (this.wss) {
        this.wss.close(() => {
          // Only a server this transport opened may be closed here.
          if (this.ownsHttpServer && this.httpServer) {
            this.httpServer.close(() => {
              this.httpServer = null;
              done();
            });
          } else {
            done();
          }
        });
      } else if (this.ownsHttpServer && this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          done();
        });
      } else {
        done();
      }
    });
  }

  onAudioChunk(
    handler: (sessionId: string, chunk: AudioChunk) => void,
  ): void {
    this.audioHandler = handler;
  }

  onConnect(handler: (session: Session) => void): void {
    this.connectHandler = handler;
  }

  onDisconnect(handler: (session: Session) => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Send PCM audio to a session.
   *
   * Chunks are dropped rather than queued once the socket backlog is large: on
   * a real-time stream a backlog is already stale, and buffering without a cap
   * grows memory without bound on a slow connection.
   */
  async sendAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    if (entry.ws.readyState !== WebSocket.OPEN) return;

    if (entry.ws.bufferedAmount > WebSocketTransport.MAX_BUFFERED_BYTES) {
      this.emitTransportError(
        new Error(
          `Dropping outbound audio for ${sessionId}: socket backlog ${entry.ws.bufferedAmount} bytes`,
        ),
      );
      return;
    }

    entry.ws.send(chunk.data);
  }

  /**
   * Send a JSON control message to a session.
   */
  async sendMessage(
    sessionId: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify(message));
    }
  }

  /** Get active session count */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /** Get a session by ID */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  private handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
  ): void {
    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      startedAt: new Date(),
      metadata: {
        remoteAddress: req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
        // Raw headers are intentionally not retained: they can carry cookies
        // and bearer tokens, and session metadata reaches call logs.
      },
      state: "active",
    };

    this.sessions.set(sessionId, {
      ws,
      session,
      isAlive: true,
      format: { sampleRate: 16000, channels: 1, bitDepth: 16 },
    });
    console.log(`[Transport] New session: ${sessionId}`);

    // Notify connection handler
    this.connectHandler?.(session);

    // Send session info to the client
    ws.send(
      JSON.stringify({
        type: "session.created",
        sessionId,
        timestamp: Date.now(),
      }),
    );

    const sessionStartTime = Date.now();

    ws.on("pong", () => {
      const entry = this.sessions.get(sessionId);
      if (entry) entry.isAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;

      if (isBinary) {
        // Binary = audio data
        const chunk: AudioChunk = {
          data: Buffer.from(data as Buffer),
          sampleRate: entry.format.sampleRate,
          channels: entry.format.channels,
          bitDepth: entry.format.bitDepth,
          timestampMs: Date.now() - sessionStartTime,
        };
        this.audioHandler?.(sessionId, chunk);
      } else {
        // Text = control message
        try {
          const message = JSON.parse(data.toString());
          this.handleControlMessage(sessionId, message);
        } catch {
          console.warn(`[Transport] Invalid control message from ${sessionId}`);
        }
      }
    });

    ws.on("close", () => {
      console.log(`[Transport] Session ended: ${sessionId}`);
      session.state = "ended";
      // Delete first and only report if this handler owned the entry. A socket
      // close is asynchronous, so a `stop()` or `closeSession()` that tore the
      // session down earlier has already removed it — reporting again would
      // fire onDisconnect twice, which runs pipeline teardown and call logging
      // a second time and writes a duplicate call log.
      const owned = this.sessions.delete(sessionId);
      if (owned) {
        this.disconnectHandler?.(session);
      }
    });

    ws.on("error", (error) => {
      console.error(`[Transport] Session error (${sessionId}):`, error.message);
    });
  }

  /**
   * Identity fields the server establishes and the client may not overwrite.
   *
   * These decide who is calling and where a call gets routed, so treating them
   * as client-supplied would let any caller impersonate another or redirect a
   * transfer.
   */
  private static readonly PROTECTED_METADATA = new Set([
    "id",
    "from",
    "to",
    "callSid",
    "caller",
    "phoneNumber",
    "accountSid",
    "streamSid",
    "telephony",
  ]);

  /**
   * Merges a client-supplied metadata patch, skipping server-owned fields.
   *
   * Prototype-polluting keys are dropped outright: `__proto__` on a plain
   * object literal can walk up the prototype chain.
   */
  private applyMetadataPatch(session: Session, patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (WebSocketTransport.PROTECTED_METADATA.has(key)) {
        console.warn(`[Transport] Ignored client attempt to overwrite "${key}"`);
        continue;
      }
      session.metadata[key] = value;
    }
  }

  private handleControlMessage(
    sessionId: string,
    message: Record<string, unknown>,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    switch (message.type) {
      case "session.update":
        // Client can annotate session metadata, but not overwrite fields the
        // server owns. A blind `Object.assign` let a client rewrite its own
        // `from`/`callSid`, which routing and call handling then trusted.
        if (message.metadata && typeof message.metadata === "object") {
          this.applyMetadataPatch(
            entry.session,
            message.metadata as Record<string, unknown>,
          );
        }
        break;

      case "audio.config": {
        // Apply the client's declared PCM format so downstream VAD/STT read
        // the audio with the right sample rate and bit depth.
        const sampleRate = Number(message.sampleRate);
        const channels = Number(message.channels);
        const bitDepth = Number(message.bitDepth);

        if (Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000) {
          entry.format.sampleRate = sampleRate;
        }
        if (Number.isFinite(channels) && (channels === 1 || channels === 2)) {
          entry.format.channels = channels;
        }
        if (bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32) {
          entry.format.bitDepth = bitDepth;
        }

        entry.session.metadata.audioFormat = { ...entry.format };
        this.emit("audioConfig", sessionId, { ...entry.format });
        break;
      }

      default:
        this.emit("controlMessage", sessionId, message);
    }
  }
}

export function createWebSocketTransport(
  options?: WebSocketTransportOptions,
): WebSocketTransport {
  return new WebSocketTransport(options);
}
