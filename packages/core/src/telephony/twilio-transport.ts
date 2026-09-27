import { EventEmitter } from "node:events";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Transport,
  TransportOptions,
  AudioChunk,
  Session,
} from "../types.js";
import { decodeTelephonyAudio, encodeTelephonyAudio, type G711Encoding } from "./codec.js";
import { createTwilioStreamTwiML } from "./twiml.js";

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

  /**
   * Twilio auth token. When set together with `publicUrl`, inbound requests to
   * the TwiML webhook must carry a valid `X-Twilio-Signature`.
   */
  authToken?: string;

  /**
   * Publicly reachable base URL of this server, e.g.
   * `https://voice.example.com`. Required for signature validation, because the
   * signature is computed over the URL Twilio dialled, which it cannot be
   * inferred from behind a proxy.
   */
  publicUrl?: string;

  /**
   * G.711 encoding for the media stream. Twilio defaults to `mulaw`; set
   * `alaw` to negotiate PCMA. Inbound audio is decoded according to whatever
   * the stream declares, regardless of this value.
   */
  encoding?: G711Encoding;

  /**
   * Restrict the TwiML webhook (and health endpoint) to these Host values.
   * Recommended in production: the auto-served TwiML embeds a stream URL
   * derived from the request's Host header.
   */
  allowedHosts?: string[];
}

interface TwilioSessionEntry {
  ws: WebSocket;
  session: Session;
  streamSid: string;
  callSid: string;
  startTime: number;
  /** G.711 flavor declared by the stream. Decoding μ-law bytes as A-law is noise. */
  encoding: G711Encoding;
  /** Sample rate declared by the stream, in Hz. */
  sampleRate: number;
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
  /** Outbound socket backlog past which audio frames are dropped (256KB). */
  private static readonly MAX_BUFFERED_BYTES = 256 * 1024;

  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private ownsHttpServer = false;
  private options: TwilioTransportOptions = { port: 8080 };

  private sessions = new Map<string, TwilioSessionEntry>();
  private audioHandler: ((sessionId: string, chunk: AudioChunk) => void) | null = null;
  private connectHandler: ((session: Session) => void) | null = null;
  private disconnectHandler: ((session: Session) => void) | null = null;
  private dtmfHandler: ((sessionId: string, digit: string) => void) | null = null;
  private droppedAudioFrames = 0;
  private warnedAboutSignature = false;

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
   * Handle incoming HTTP requests (TwiML serving and health status).
   */
  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    streamPath: string,
    webhookPath: string | null
  ): Promise<void> {
    const rawHost = req.headers.host ?? "localhost";
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", `http://${rawHost}`).pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    // Host allowlist — the stream URL below is derived from this header, so an
    // unvalidated value lets a caller inject an arbitrary wss:// target into
    // the TwiML we hand back.
    if (!this.isHostAllowed(rawHost)) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      res.end("Misdirected Request");
      return;
    }

    // Check if request is for the Twilio Voice webhook
    if (webhookPath && (pathname === webhookPath || pathname === "/twilio/voice")) {
      // Twilio's signature covers the POST body, so it has to be read before
      // validation rather than after the response is written.
      const body = await readRequestBody(req);

      if (!this.isValidTwilioSignature(req, body)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      // Derive the stream URL from the vetted Host header, not raw input.
      const host = this.normalizeHost(rawHost);
      const defaultStreamUrl = host ? `wss://${host}${streamPath}` : "";
      const streamUrl = this.options.streamUrl || defaultStreamUrl;

      if (!streamUrl) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("No usable stream URL — set options.streamUrl or a valid Host header");
        return;
      }

      const twiml = createTwilioStreamTwiML({
        streamUrl,
        greeting: this.options.greeting,
        encoding: this.streamEncoding,
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

  /** G.711 flavor advertised in the generated TwiML. */
  private get streamEncoding(): G711Encoding {
    return this.options.encoding === "alaw" ? "alaw" : "mulaw";
  }

  /**
   * Restrict a Host header to DNS/IP characters and a port.
   * Returns "" if the value contains anything else, so it cannot terminate the
   * host portion of a generated URL.
   */
  private normalizeHost(rawHost: string): string {
    const match = /^([a-zA-Z0-9.-]{1,253}|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(rawHost);
    if (!match) return "";
    const port = match[2] ? `:${Number(match[2])}` : "";
    return `${match[1]}${port}`;
  }

  private isHostAllowed(rawHost: string): boolean {
    const allowed = this.options.allowedHosts;
    if (!allowed || allowed.length === 0) return true;

    const host = this.normalizeHost(rawHost);
    if (!host) return false;

    // Compare on hostname, ignoring the port, so a single entry covers :80/:443.
    const hostname = host.replace(/:\d+$/, "");
    return allowed.some((entry) => {
      const candidate = this.normalizeHost(entry);
      if (!candidate) return false;
      return candidate === host || candidate.replace(/:\d+$/, "") === hostname;
    });
  }

  /**
   * Validate Twilio's `X-Twilio-Signature` when auth is configured.
   *
   * Skipped (with a one-time warning) unless both `authToken` and `publicUrl`
   * are set, since the signature covers the exact URL Twilio requested.
   */
  private isValidTwilioSignature(req: IncomingMessage, body: string): boolean {
    const { authToken, publicUrl } = this.options;
    const signature = req.headers["x-twilio-signature"];

    if (!authToken || !publicUrl) {
      if (!this.warnedAboutSignature && signature) {
        this.warnedAboutSignature = true;
        console.warn(
          "[Telephony] Received an X-Twilio-Signature but authToken/publicUrl are not " +
            "configured, so the request cannot be verified. Set both to validate callers.",
        );
      }
      return true;
    }

    if (typeof signature !== "string" || !signature) return false;

    const url = `${publicUrl.replace(/\/+$/, "")}${req.url ?? "/"}`;
    const params = new URLSearchParams(body);

    const data =
      url +
      Array.from(params.keys())
        .sort()
        .map((key) => `${key}${params.get(key)}`)
        .join("");

    const expected = createHmac("sha1", authToken)
      .update(data, "utf8")
      .digest("base64");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
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

            // Honor the stream's declared format instead of assuming μ-law 8k.
            const mediaFormat = (startData.mediaFormat ?? {}) as {
              encoding?: string;
              sampleRate?: number;
              channels?: number;
            };
            const encoding: G711Encoding =
              String(mediaFormat.encoding ?? "mulaw").toLowerCase() === "alaw"
                ? "alaw"
                : "mulaw";
            const sampleRate =
              typeof mediaFormat.sampleRate === "number" && mediaFormat.sampleRate > 0
                ? mediaFormat.sampleRate
                : 8000;

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
                mediaFormat,
                // Deliberately not captured: raw HTTP headers. They can carry
                // cookies and auth tokens, and this metadata reaches call logs.
                remoteAddress: req?.socket.remoteAddress,
              },
              state: "active",
            };

            sessionEntry = {
              ws,
              session,
              streamSid,
              callSid,
              startTime: Date.now(),
              encoding,
              sampleRate,
            };

            this.sessions.set(streamSid, sessionEntry);
            console.log(
              `[Telephony] Call started — Stream: ${streamSid}, CallSid: ${callSid} (${encoding} ${sampleRate}Hz)`,
            );
            this.connectHandler?.(session);
            this.emit("callStarted", session);
            break;
          }

          case "media": {
            if (!sessionEntry || !this.audioHandler) break;
            const media = msg.media;
            if (!media || !media.payload) break;

            const payload = Buffer.from(media.payload, "base64");
            const pcm16k = decodeTelephonyAudio(
              payload,
              sessionEntry.encoding,
              sessionEntry.sampleRate,
            );

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

          case "dtmf": {
            // Twilio delivers keypad tones as a top-level event on
            // bidirectional streams (inbound direction only).
            const digit = (msg.dtmf?.digit ?? "") as string;
            if (digit && sessionEntry) {
              this.dtmfHandler?.(
                sessionEntry.session.id,
                digit,
              );
            }
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

  onDTMF(handler: (sessionId: string, digit: string) => void): void {
    this.dtmfHandler = handler;
  }

  /**
   * Transcode outgoing linear PCM audio and stream it to the caller.
   *
   * Audio is dropped rather than queued when the socket is congested: this is a
   * real-time stream, so a backlog is already stale by the time it would be
   * played. Buffering without a cap would grow memory without limit on a slow
   * or half-open connection.
   */
  async sendAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (entry.ws.bufferedAmount > TwilioTransport.MAX_BUFFERED_BYTES) {
      this.droppedAudioFrames++;
      if (this.droppedAudioFrames % 50 === 1) {
        console.warn(
          `[Telephony] Dropping outbound audio for ${sessionId}: socket backlog ` +
            `${entry.ws.bufferedAmount} bytes exceeds ${TwilioTransport.MAX_BUFFERED_BYTES}`,
        );
      }
      return;
    }

    const payload = encodeTelephonyAudio(
      chunk.data,
      chunk.sampleRate,
      entry.encoding,
    ).toString("base64");

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

/**
 * Read a request body with a hard size cap.
 *
 * The webhook only needs Twilio's small form-encoded call parameters, and an
 * unbounded read would be a free memory-exhaustion vector on a public endpoint.
 */
function readRequestBody(req: IncomingMessage, limitBytes = 16 * 1024): Promise<string> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve("");

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export function createTwilioTransport(options?: Partial<TwilioTransportOptions>): TwilioTransport {
  return new TwilioTransport(options);
}
