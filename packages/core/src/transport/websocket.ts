import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
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

  async start(options: TransportOptions & { path?: string }): Promise<void> {
    const path = options.path ?? this.options.path;

    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: options.port,
          host: options.host ?? "0.0.0.0",
          path,
          // Compressing PCM audio burns CPU for no meaningful size win.
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

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all active sessions
    for (const { ws, session } of this.sessions.values()) {
      session.state = "ended";
      ws.close();
      this.disconnectHandler?.(session);
    }
    this.sessions.clear();

    // Shut down the server
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          console.log("[Transport] WebSocket server stopped");
          resolve();
        });
      } else {
        resolve();
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
      this.disconnectHandler?.(session);
      this.sessions.delete(sessionId);
    });

    ws.on("error", (error) => {
      console.error(`[Transport] Session error (${sessionId}):`, error.message);
    });
  }

  private handleControlMessage(
    sessionId: string,
    message: Record<string, unknown>,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    switch (message.type) {
      case "session.update":
        // Client can update session metadata
        if (message.metadata && typeof message.metadata === "object") {
          Object.assign(entry.session.metadata, message.metadata);
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
