import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Transport,
  TransportOptions,
  AudioChunk,
  Session,
  DEFAULT_AUDIO_FORMAT,
} from "../types.js";

/**
 * WebSocketTransport — Handles real-time audio streaming over WebSocket.
 *
 * Protocol:
 * - Client connects to ws://host:port
 * - Binary frames = raw PCM audio data
 * - JSON text frames = control messages (metadata, config, etc.)
 *
 * This is the default transport for Phase 1. WebRTC transport
 * will be added in Phase 3 for lower-latency applications.
 */
export class WebSocketTransport extends EventEmitter implements Transport {
  private wss: WebSocketServer | null = null;
  private sessions: Map<string, { ws: WebSocket; session: Session }> =
    new Map();
  private audioHandler:
    | ((sessionId: string, chunk: AudioChunk) => void)
    | null = null;
  private connectHandler: ((session: Session) => void) | null = null;
  private disconnectHandler: ((session: Session) => void) | null = null;

  async start(options: TransportOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: options.port,
          host: options.host ?? "0.0.0.0",
        });

        this.wss.on("connection", (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wss.on("listening", () => {
          console.log(
            `[Transport] WebSocket server listening on ${options.host ?? "0.0.0.0"}:${options.port}`,
          );
          resolve();
        });

        this.wss.on("error", (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    // Close all active sessions
    for (const [sessionId, { ws, session }] of this.sessions) {
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

  async sendAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(chunk.data);
    }
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
    req: import("http").IncomingMessage,
  ): void {
    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      startedAt: new Date(),
      metadata: {
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
      },
      state: "active",
    };

    this.sessions.set(sessionId, { ws, session });
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

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Binary = audio data
        const chunk: AudioChunk = {
          data: Buffer.from(data as Buffer),
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
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

      case "audio.config":
        // Client specifying audio format (future: handle format conversion)
        this.emit("audioConfig", sessionId, message);
        break;

      default:
        this.emit("controlMessage", sessionId, message);
    }
  }
}

export function createWebSocketTransport(): WebSocketTransport {
  return new WebSocketTransport();
}
