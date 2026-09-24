import { EventEmitter } from "node:events";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Transport,
  TransportOptions,
  AudioChunk,
  Session,
} from "../types.js";
import { mulaw8kToPcm16k, pcm16ToMulaw8k } from "./codec.js";
import { createTwilioStreamTwiML, type TwilioStreamTwiMLOptions } from "./twiml.js";

export interface TwilioTransportOptions extends TransportOptions {
  /**
   * WebSocket stream path (default: "/media").
   * Incoming Twilio Media Streams connect here.
   */
  path?: string;

  /**
   * HTTP path where Twilio can fetch TwiML instructions for incoming calls (default: "/voice").
   * Set to null to disable automatic HTTP TwiML serving.
   */
  webhookPath?: string | null;

  /**
   * Public stream URL forwarded in auto-served TwiML (e.g. "wss://voice.mycompany.com/media").
   */
  streamUrl?: string;

  /**
   * Optional verbal greeting spoken by Twilio before connecting the media stream in auto-served TwiML.
   */
  greeting?: string;

  /**
   * Existing Node HTTP/HTTPS server instance to attach to (optional).
   */
  server?: http.Server;
}

interface TwilioSessionEntry {
  ws: WebSocket;
  session: Session;
  streamSid: string;
  callSid: string;
  startTime: number;
}

/**
 * TwilioTransport — Telephony Transport for Twilio Media Streams & Mobile Providers.
 *
 * Provides real-time bidirectional audio streaming between mobile phone calls
 * and Felona Voice's JEV engine:
 * - Decodes incoming 8kHz μ-law telephony packets into 16kHz linear PCM
 * - Encodes outgoing TTS audio into 8kHz μ-law
 * - Supports barge-in interruption clearing via Twilio "clear" events
 * - Serves auto-generated TwiML for zero-config phone number webhooks
 */
export class TwilioTransport extends EventEmitter implements Transport {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private ownsHttpServer = false;
  private options: TwilioTransportOptions = { port: 8080 };

  private sessions = new Map<string, TwilioSessionEntry>();
  private audioHandler: ((sessionId: string, chunk: AudioChunk) => void) | null = null;
  private connectHandler: ((session: Session) => void) | null = null;
  private disconnectHandler: ((session: Session) => void) | null = null;

  constructor(options?: Partial<TwilioTransportOptions>) {
    super();
    if (options) {
      this.options = { ...this.options, ...options };
    }
  }

  async start(options?: TransportOptions): Promise<void> {
    if (options) {
      this.options = { ...this.options, ...options };
    }

    const port = this.options.port ?? 8080;
    const host = this.options.host ?? "0.0.0.0";
    const streamPath = this.options.path ?? "/media";
    const webhookPath = this.options.webhookPath !== undefined ? this.options.webhookPath : "/voice";

    return new Promise((resolve, reject) => {
      try {
        if (this.options.server) {
          // Attach to existing HTTP server
          this.httpServer = this.options.server;
          this.ownsHttpServer = false;
          this.wss = new WebSocketServer({
            server: this.httpServer,
            path: streamPath,
          });
          this.setupWss();
          resolve();
        } else {
          // Create standalone HTTP + WebSocket server
          this.ownsHttpServer = true;
          this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res, streamPath, webhookPath);
          });

          this.wss = new WebSocketServer({
            server: this.httpServer,
            path: streamPath,
          });
          this.setupWss();

          this.httpServer.listen(port, host, () => {
            console.log(`[Telephony] Twilio Transport listening on ${host}:${port}`);
            console.log(`  Stream WebSocket:  ws://${host}:${port}${streamPath}`);
            if (webhookPath) {
              console.log(`  TwiML Webhook:     http://${host}:${port}${webhookPath}`);
            }
            resolve();
          });

          this.httpServer.on("error", (err) => {
            reject(err);
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  private setupWss(): void {
    if (!this.wss) return;

    this.wss.on("connection", (ws, req) => {
      this.handleWebSocket(ws, req);
    });

    this.wss.on("error", (err) => {
      this.emit("error", err);
    });
  }

  /**
   * Handle incoming HTTP requests (automatic TwiML serving and health status).
   */
  private handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    streamPath: string,
    webhookPath: string | null
  ): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Check if request is for the Twilio Voice webhook
    if (webhookPath && (pathname === webhookPath || pathname === "/twilio/voice")) {
      const host = req.headers.host ?? "localhost";
      const defaultStreamUrl = `wss://${host}${streamPath}`;
      const streamUrl = this.options.streamUrl || defaultStreamUrl;

      const twiml = createTwilioStreamTwiML({
        streamUrl,
        greeting: this.options.greeting,
      });

      res.writeHead(200, {
        "Content-Type": "text/xml; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(twiml);
      return;
    }

    // Health check endpoint
    if (pathname === "/" || pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "felona-voice-telephony",
          provider: "twilio",
          activeCalls: this.sessions.size,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  /**
   * Attach and handle an existing WebSocket connection (e.g. from an Express/Fastify server).
   */
  handleWebSocket(ws: WebSocket, req?: IncomingMessage): void {
    let currentStreamSid: string | null = null;
    let sessionEntry: TwilioSessionEntry | null = null;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const event = msg.event;

        switch (event) {
          case "connected":
            this.emit("telephonyConnected", { protocol: msg.protocol, version: msg.version });
            break;

          case "start": {
            const startData = msg.start || {};
            const streamSid = (startData.streamSid || msg.streamSid || "twilio-" + Date.now()) as string;
            const callSid = (startData.callSid || "") as string;
            currentStreamSid = streamSid;

            const session: Session = {
              id: streamSid,
              startedAt: new Date(),
              metadata: {
                telephony: "twilio",
                streamSid,
                callSid,
                accountSid: startData.accountSid,
                tracks: startData.tracks,
                customParameters: startData.customParameters ?? {},
                from: startData.customParameters?.From ?? startData.customParameters?.caller,
                to: startData.customParameters?.To ?? startData.customParameters?.called,
                mediaFormat: startData.mediaFormat,
                headers: req?.headers,
              },
              state: "active",
            };

            sessionEntry = {
              ws,
              session,
              streamSid,
              callSid,
              startTime: Date.now(),
            };

            this.sessions.set(streamSid, sessionEntry);
            console.log(`[Telephony] Call started — Stream: ${streamSid}, CallSid: ${callSid}`);
            this.connectHandler?.(session);
            this.emit("callStarted", session);
            break;
          }

          case "media": {
            if (!sessionEntry || !this.audioHandler) break;
            const media = msg.media;
            if (!media || !media.payload) break;

            const mulawBuffer = Buffer.from(media.payload, "base64");
            const pcm16k = mulaw8kToPcm16k(mulawBuffer);

            const chunk: AudioChunk = {
              data: pcm16k,
              sampleRate: 16000,
              channels: 1,
              bitDepth: 16,
              timestampMs: Date.now() - sessionEntry.startTime,
            };

            this.audioHandler(sessionEntry.session.id, chunk);
            break;
          }

          case "mark": {
            if (sessionEntry) {
              const markName = msg.mark?.name ?? "";
              this.emit("mark", sessionEntry.session.id, markName);
            }
            break;
          }

          case "stop": {
            if (sessionEntry) {
              console.log(`[Telephony] Call ended — Stream: ${sessionEntry.streamSid}`);
              sessionEntry.session.state = "ended";
              this.disconnectHandler?.(sessionEntry.session);
              this.emit("callEnded", sessionEntry.session);
              this.sessions.delete(sessionEntry.streamSid);
              sessionEntry = null;
            }
            break;
          }

          default:
            this.emit("controlMessage", currentStreamSid, msg);
            break;
        }
      } catch (err) {
        console.warn("[Telephony] Failed to parse Twilio message:", err);
      }
    });

    ws.on("close", () => {
      if (sessionEntry) {
        sessionEntry.session.state = "ended";
        this.disconnectHandler?.(sessionEntry.session);
        this.emit("callEnded", sessionEntry.session);
        this.sessions.delete(sessionEntry.streamSid);
      }
    });

    ws.on("error", (error) => {
      console.error(`[Telephony] WebSocket error (${currentStreamSid ?? "unknown"}):`, error.message);
    });
  }

  async stop(): Promise<void> {
    for (const [, entry] of this.sessions) {
      entry.session.state = "ended";
      entry.ws.close();
      this.disconnectHandler?.(entry.session);
    }
    this.sessions.clear();

    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });

    if (this.ownsHttpServer && this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
    }

    console.log("[Telephony] Twilio Transport stopped");
  }

  onAudioChunk(handler: (sessionId: string, chunk: AudioChunk) => void): void {
    this.audioHandler = handler;
  }

  onConnect(handler: (session: Session) => void): void {
    this.connectHandler = handler;
  }

  onDisconnect(handler: (session: Session) => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Transcode outgoing linear PCM audio to 8kHz μ-law and stream to Twilio caller.
   */
  async sendAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const mulaw = pcm16ToMulaw8k(chunk.data, chunk.sampleRate);
    const payload = mulaw.toString("base64");

    const message = {
      event: "media",
      streamSid: entry.streamSid,
      media: {
        payload,
      },
    };

    entry.ws.send(JSON.stringify(message));
  }

  /**
   * Barge-in interruption: immediately silence buffered audio on caller's mobile phone.
   */
  async clearAudio(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;

    const message = {
      event: "clear",
      streamSid: entry.streamSid,
    };

    entry.ws.send(JSON.stringify(message));
  }

  /**
   * Send a mark event to Twilio to track playback synchronization.
   */
  async sendMark(sessionId: string, name: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;

    const message = {
      event: "mark",
      streamSid: entry.streamSid,
      mark: { name },
    };

    entry.ws.send(JSON.stringify(message));
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }
}

export function createTwilioTransport(options?: Partial<TwilioTransportOptions>): TwilioTransport {
  return new TwilioTransport(options);
}
