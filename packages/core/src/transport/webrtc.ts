/**
 * WebRTCTransport — browser-to-agent audio over WebRTC.
 *
 * WebSocket is the default transport and the right one for server-to-server
 * media. WebRTC earns its place for a browser or mobile client, because the
 * media path is already encrypted and already handles NAT traversal: there is
 * no TURN bill, no TLS termination for the media, and the browser gives you
 * echo cancellation and jitter buffering for free.
 *
 * ## How a connection is made
 *
 * WebRTC needs a signalling channel, and it cannot be the media path itself, so
 * this transport runs a small HTTP endpoint alongside the peer connections:
 *
 *   POST /offer   { sdp, type? }        -> 200 { sessionId, answer }
 *   POST /ice     { sessionId, candidate } -> 204
 *
 * The client POSTs its offer, gets an answer plus the session id it will be
 * known by from then on, and can trickle further ICE candidates. Trickling is
 * optional: host and server-reflexive candidates are usually enough on a LAN,
 * and `waitForIceGathering` exists for clients that would rather send one
 * complete offer and not deal with the second endpoint at all.
 *
 * ## Audio format
 *
 * PCMU (G.711 μ-law) at 8 kHz, carried as RTP. See {@link ./rtp.ts} for why
 * this codec specifically. Browsers accept PCMU in a WebRTC offer without any
 * codec negotiation games, and the telephony path already converts to and from
 * exactly this format, so a deployment that runs both transports converts
 * audio only once.
 */

import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Transport, TransportOptions, AudioChunk, Session } from "../types.js";
import { mulaw8kToPcm16k, pcm16ToMulaw8k } from "../telephony/codec.js";
import {
  PcmuPacketizer,
  parseRtpAudioPacket,
  serializeRtpAudioPacket,
  type RtpAudioPacket,
} from "./rtp.js";

// ─── Peer connection contract ───────────────────────────────────────────────

/** The subset of a peer connection this transport uses. */
export interface PeerConnectionLike {
  addTransceiver(
    trackOrKind: unknown,
    options?: Record<string, unknown>,
  ): unknown;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp: string } | null>;
  /** Apply a locally generated answer. Required before candidates are gathered. */
  setLocalDescription?(description: { type: string; sdp: string }): Promise<void>;
  /** Apply a trickled ICE candidate. Absent on stacks that gather eagerly. */
  addIceCandidate?(candidate: unknown): Promise<void>;
  localDescription: { type: string; sdp: string } | null;
  close(): void;
  on?(event: string, handler: (...args: never[]) => void): void;
  readonly connectionState?: string;
}

/** A media track this transport can write RTP into and read RTP from. */
export interface MediaTrackLike {
  writeRtp(packet: Buffer | unknown): void;
  stop?(): void;
  onReceiveRtp?: {
    subscribe(
      handler: (packet: { payload: Buffer; header?: unknown }) => void,
    ): { un?: () => void; unSubscribe?: () => void };
  };
}

/**
 * Creates a peer connection. Injected so the signalling logic can be tested
 * without a network, and so a different WebRTC stack can be swapped in.
 */
export type PeerConnectionFactory = (
  config: Record<string, unknown>,
) => PeerConnectionLike;

export interface WebRTCTransportOptions {
  /**
   * Shared secret. Callers must present it as `Authorization: Bearer <value>`
   * or `?token=<value>`. WebRTC media is DTLS-SRTP encrypted, but the signalling
   * endpoint is plain HTTP and will hand an attacker a peer connection if left
   * open — so set this for anything reachable off-box.
   */
  authToken?: string;
  /** Custom connection check, taking precedence over `authToken`. */
  verifyClient?: (req: IncomingMessage) => boolean;
  /** Path the signalling endpoint is served on. Default: `/offer`. */
  path?: string;
  /**
   * Maximum simultaneous calls. Default: Infinity. Rejected callers get a 503,
   * because a WebRTC peer that is accepted and then starved is worse than one
   * refused up front.
   */
  maxConnections?: number;
  /**
   * Milliseconds to wait for ICE gathering to finish before answering.
   *
   * Default: 3000. An answer with no candidates in it cannot connect on its
   * own, so waiting is what makes the common single-offer handshake work
   * without any trickle. Set to 0 to answer immediately and rely on
   * `POST /offer/ice` instead, which is faster to first answer but needs the
   * client to actually trickle.
   */
  waitForIceGatheringMs?: number;
  /**
   * Direction of the agent's audio transceiver. Default: `sendrecv`.
   *
   * Only lower this for a genuinely one-way deployment — a broadcast agent that
   * never listens — because `recvonly` leaves the reply with no track to send
   * on, and `sendonly` leaves the agent deaf.
   */
  direction?: "sendrecv" | "sendonly" | "recvonly";
  /** Peer connection configuration passed to the factory. */
  peerConfig?: Record<string, unknown>;
  /** Peer connection factory. Defaults to the bundled WebRTC stack. */
  createPeerConnection?: PeerConnectionFactory;
  /**
   * Creates the local audio track the agent speaks on. Defaults to the bundled
   * stack's track type.
   *
   * A track has to be supplied explicitly: adding a transceiver by *kind* gives
   * the sender no track, and the only track then reachable is the receiver's —
   * which is remote and refuses writes. Inject this alongside
   * `createPeerConnection` when supplying a different stack.
   */
  createAudioTrack?: () => MediaTrackLike;
}

// ─── Session ────────────────────────────────────────────────────────────────

interface WebRTCSessionEntry {
  session: Session;
  peer: PeerConnectionLike;
  track: MediaTrackLike;
  packetizer: PcmuPacketizer;
  /** μ-law bytes received but not yet emitted as a chunk. */
  inbound: Buffer;
  startedAt: number;
  closed: boolean;
  /** Unsubscribers for peer events, run on teardown so they do not leak. */
  disposers: Array<() => void>;
}

const MAX_SIGNALING_BODY_BYTES = 256 * 1024;

export class WebRTCTransport extends EventEmitter implements Transport {
  private server: Server | null = null;
  /** Whether stop() may close the server. False for a caller-supplied one. */
  private ownsServer = false;
  private createAudioTrack: (() => MediaTrackLike) | null = null;
  private readonly sessions = new Map<string, WebRTCSessionEntry>();
  private options: WebRTCTransportOptions = {};
  private audioHandler:
    | ((sessionId: string, chunk: AudioChunk) => void)
    | null = null;
  private connectHandler: ((session: Session) => void) | null = null;
  private disconnectHandler: ((session: Session) => void) | null = null;

  constructor(options?: WebRTCTransportOptions) {
    super();
    this.options = { ...this.options, ...options };
  }

  async start(options: TransportOptions): Promise<void> {
    if (this.server) {
      throw new Error("WebRTCTransport is already started");
    }
    // Fail at startup, not on the first call: a missing WebRTC stack should be
    // a boot error, never a dropped call at 3am.
    const createPeer = this.options.createPeerConnection ?? (await defaultPeerFactory());
    this.createAudioTrack = this.options.createAudioTrack ?? (await defaultAudioTrackFactory());

    const server = (options.server ?? createServer()) as Server;
    // Attached in both cases. Handing the transport a caller-owned server is how
    // a deployment shares one port with its own routes, and building the
    // handler into createServer() alone would leave those requests unanswered.
    server.on("request", (req, res) => {
      void this.handleSignaling(req, res, createPeer);
    });
    this.server = server;
    // Only a server this transport opened may be closed by stop().
    this.ownsServer = !options.server;

    return new Promise((resolve, reject) => {
      let settled = false;
      const onError = (error: Error) => {
        if (settled) {
          this.emitSafe("transportError", error);
          return;
        }
        settled = true;
        reject(error);
      };

      server.once("error", onError);
      server.on("listening", () => {
        settled = true;
        console.log(
          `[Transport] WebRTC signalling listening on ${options.host ?? "0.0.0.0"}:${portOf(server)}${this.options.path ?? "/offer"}`,
        );
        resolve();
      });

      if (options.server) {
        // An externally-managed server is already listening.
        settled = true;
        resolve();
      } else {
        server.listen(options.port, options.host ?? "0.0.0.0");
      }
    });
  }

  async stop(): Promise<void> {
    for (const entry of this.sessions.values()) {
      this.teardown(entry);
    }
    this.sessions.clear();

    const server = this.server;
    const owns = this.ownsServer;
    this.server = null;
    this.ownsServer = false;
    if (!server) return;

    if (!owns) {
      // A caller-supplied server is shared with the rest of their app; closing
      // it would take down routes that have nothing to do with this transport.
      return;
    }

    return new Promise((resolve) => {
      server.close(() => {
        console.log("[Transport] WebRTC signalling stopped");
        resolve();
      });
      // Keep-alive sockets would otherwise hold the close open indefinitely.
      server.closeAllConnections?.();
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
   * The port the signalling endpoint is listening on, or 0 when it is not
   * started. Useful when starting on port 0 and letting the OS choose.
   */
  get serverAddress(): number {
    return portOf(this.server ?? (undefined as unknown as Server));
  }

  /** Number of live WebRTC calls. */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * Send PCM audio to a caller.
   *
   * Audio is transcoded to 8 kHz μ-law and packetized; anything shorter than a
   * 20 ms frame is held until the rest arrives, so the wire only ever sees whole
   * frames.
   */
  async sendAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed) {
      throw new Error(`WebRTC session "${sessionId}" not found`);
    }

    const mulaw = pcm16ToMulaw8k(chunk.data, chunk.sampleRate);
    if (mulaw.length === 0) return;

    for (const packet of entry.packetizer.push(mulaw)) {
      try {
        entry.track.writeRtp(serializeRtpAudioPacket(packet));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitSafe(
          "transportError",
          new Error(`Failed to write RTP for ${sessionId}: ${err.message}`),
        );
        return;
      }
    }
  }

  /**
   * Drop audio queued for playback.
   *
   * The WebRTC equivalent of barge-in: frames already handed to the packetizer
   * describe audio the caller has started talking over.
   */
  async clearAudio(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.packetizer.flush();
  }

  /**
   * JSON control message.
   *
   * There is no data channel in this transport, so this reports that plainly
   * rather than appearing to work.
   */
  async sendMessage(
    sessionId: string,
    _message: Record<string, unknown>,
  ): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`WebRTC session "${sessionId}" not found`);
    }
    throw new Error(
      "WebRTCTransport has no data channel, so sendMessage is not supported. " +
        "Use a WebSocket transport if you need a control channel.",
    );
  }

  // ─── Signalling ──────────────────────────────────────────────────────────

  private async handleSignaling(
    req: IncomingMessage,
    res: ServerResponse,
    createPeer: PeerConnectionFactory,
  ): Promise<void> {
    try {
      const path = this.options.path ?? "/offer";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === path) {
        if (req.method !== "POST") {
          this.sendJson(res, 405, { error: "Use POST for the offer endpoint" });
          return;
        }
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        await this.handleOffer(req, res, createPeer);
        return;
      }

      if (url.pathname === `${stripTrailingSlash(path)}/ice`) {
        if (req.method !== "POST") {
          this.sendJson(res, 405, { error: "Use POST for the ICE endpoint" });
          return;
        }
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        await this.handleIceCandidate(req, res);
        return;
      }

      this.sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitSafe("transportError", err);
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: err.message });
      }
    }
  }

  private async handleOffer(
    req: IncomingMessage,
    res: ServerResponse,
    createPeer: PeerConnectionFactory,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const sdp = typeof body.sdp === "string" ? body.sdp : "";
    if (!sdp) {
      this.sendJson(res, 400, { error: "Missing `sdp` in offer body" });
      return;
    }

    const max = this.options.maxConnections;
    if (max !== undefined && this.sessions.size >= max) {
      this.sendJson(res, 503, { error: `At capacity (max ${max} calls)` });
      return;
    }

    const peer = createPeer(this.options.peerConfig ?? {});
    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      startedAt: new Date(),
      // A WebRTC peer exposes no address behind its relays, so there is nothing
      // honest to record here and inventing one would be worse than nothing.
      metadata: { transport: "webrtc" },
      state: "active",
    };

    // Audio only, and bidirectional: the agent both speaks and listens.
    //
    // The track is created here and handed to the transceiver, rather than
    // adding a transceiver by kind. A kind-only transceiver leaves the sender
    // without a track, and the only track reachable afterwards is the
    // receiver's — which is remote and rejects writes, so the agent's reply
    // would go nowhere.
    const createTrack = this.createAudioTrack;
    if (!createTrack) {
      peer.close();
      this.sendJson(res, 500, { error: "Transport was not started" });
      return;
    }
    const outboundTrack = createTrack();
    const transceiver = peer.addTransceiver(outboundTrack, {
      direction: this.options.direction ?? "sendrecv",
    });
    const track = resolveTrack(transceiver) ?? outboundTrack;

    const entry: WebRTCSessionEntry = {
      session,
      peer,
      track,
      packetizer: new PcmuPacketizer(),
      inbound: Buffer.alloc(0),
      startedAt: Date.now(),
      closed: false,
      disposers: [],
    };

    try {
      await peer.setRemoteDescription({ type: body.type === "answer" ? "answer" : "offer", sdp });

      const answer = await peer.createAnswer();
      if (!answer) {
        peer.close();
        this.sendJson(res, 500, { error: "Failed to create answer" });
        return;
      }

      // Order matters. Creating the answer starts ICE gathering, but the
      // candidates only land in the local description after it is applied — and
      // an answer sent without them cannot connect, so a client that sends one
      // offer and waits would hang at "connecting" forever.
      if (peer.setLocalDescription) {
        await peer.setLocalDescription(answer);
      }
      const waitMs = this.options.waitForIceGatheringMs ?? 3000;
      if (waitMs > 0) await waitForIceGathering(peer, waitMs);

      // Read the description back after waiting: it is updated in place as
      // candidates arrive, and the object createAnswer returned is a snapshot
      // from before gathering started.
      const settledAnswer = peer.localDescription ?? answer;

      this.sessions.set(sessionId, entry);
      this.subscribeInbound(entry);
      this.watchPeerState(entry);

      this.connectHandler?.(session);
      console.log(`[Transport] New WebRTC session: ${sessionId}`);

      this.sendJson(res, 200, { sessionId, answer: settledAnswer });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      peer.close();
      this.sendJson(res, 500, { error: err.message });
    }
  }

  private async handleIceCandidate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) {
      this.sendJson(res, 400, { error: "Missing `sessionId`" });
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.sendJson(res, 404, { error: "Unknown session" });
      return;
    }

    // Applying the candidate is what makes trickle work. Accepting it and
    // dropping it would leave a client that trickles — and every client that
    // asked for an immediate answer — silently unable to connect.
    if (entry.peer.addIceCandidate) {
      try {
        await entry.peer.addIceCandidate(body.candidate ?? null);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sendJson(res, 400, { error: `Invalid candidate: ${err.message}` });
        return;
      }
    }
    res.writeHead(204).end();
  }

  /**
   * Turn inbound RTP into audio chunks.
   *
   * Packets are buffered and emitted once a frame's worth has arrived, so the
   * pipeline sees 20 ms PCM16 chunks at its own sample rate rather than
   * whatever size the network happened to deliver.
   */
  private subscribeInbound(entry: WebRTCSessionEntry): void {
    const onPacket = entry.track.onReceiveRtp;
    if (!onPacket?.subscribe) return;

    const subscription = onPacket.subscribe((packet: { payload: Buffer }) => {
      if (entry.closed) return;

      const parsed = readRtpPacket(packet);
      if (!parsed) return;

      // PCMU is the only inbound codec this transport negotiates; anything else
      // would be decoded as noise rather than a language.
      if (parsed.header.payloadType !== 0) return;

      entry.inbound = Buffer.concat([entry.inbound, parsed.payload]);
      if (entry.inbound.length < 160) return;

      const pcm = mulaw8kToPcm16k(entry.inbound);
      entry.inbound = Buffer.alloc(0);

      this.audioHandler?.(entry.session.id, {
        data: pcm,
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        timestampMs: Date.now() - entry.startedAt,
      });
    });

    entry.disposers.push(() => unsubscribe(subscription));
  }

  /**
   * End a call when the peer connection drops.
   *
   * WebRTC has no "close" frame, so a caller navigating away is only visible as
   * a state change. Without this the session would linger and hold a slot.
   */
  private watchPeerState(entry: WebRTCSessionEntry): void {
    const peer = entry.peer as PeerConnectionLike & {
      onConnectionStateChange?: {
        subscribe(handler: (state: string) => void): { un(): void };
      };
    };

    const notify = (state: string) => {
      if (state === "closed" || state === "failed") {
        this.endSession(entry.session.id, state);
      }
    };

    if (peer.onConnectionStateChange?.subscribe) {
      const subscription = peer.onConnectionStateChange.subscribe(notify);
      entry.disposers.push(() => unsubscribe(subscription));
      return;
    }
    // EventEmitter-shaped stacks.
    peer.on?.("connectionstatechange", (() => {
      notify(peer.connectionState ?? "closed");
    }) as never);
  }

  private endSession(sessionId: string, reason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed) return;
    this.teardown(entry);
    this.sessions.delete(sessionId);
    console.log(`[Transport] WebRTC session ended: ${sessionId} (${reason})`);
  }

  private teardown(entry: WebRTCSessionEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.session.state = "ended";

    for (const dispose of entry.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // A peer that has already gone may throw on unsubscribe; the close
        // below is what actually releases it.
      }
    }
    try {
      entry.track.stop?.();
    } catch {
      // A track whose peer is already gone cannot be stopped; the peer close
      // below is what actually releases it.
    }
    try {
      entry.peer.close();
    } catch {
      // Already closed.
    }
    this.disconnectHandler?.(entry.session);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Constant-time token check, matching the WebSocket transport.
   *
   * The signalling endpoint hands out peer connections, so an unauthenticated
   * deployment is a freeVoIP service for anyone who finds the port.
   */
  private authorize(req: IncomingMessage, url: URL): boolean {
    const { authToken, verifyClient } = this.options;

    if (verifyClient) {
      try {
        return verifyClient(req);
      } catch {
        return false;
      }
    }
    if (!authToken) return true;

    const header = req.headers.authorization;
    const bearer =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : "";
    const provided = bearer || url.searchParams.get("token") || "";
    if (!provided) return false;

    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(authToken, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    payload: Record<string, unknown>,
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  /** `error` is fatal on a bare EventEmitter, so it is never emitted. */
  private emitSafe(event: string, ...args: unknown[]): void {
    if (event === "error" && this.listenerCount("error") === 0) {
      console.error("[Transport]", args[0] instanceof Error ? args[0].message : args[0]);
      return;
    }
    this.emit(event, ...args);
  }
}

// ─── Free functions ─────────────────────────────────────────────────────────

/**
 * Normalise an inbound media packet.
 *
 * Stacks disagree on what they hand a subscriber: some deliver a parsed packet
 * with `header` and `payload` already split, others deliver the raw wire bytes.
 * Treating the parsed form as wire bytes silently yields a garbage header, so
 * both shapes are recognised rather than assumed.
 */
function readRtpPacket(packet: unknown): RtpAudioPacket | null {
  if (Buffer.isBuffer(packet)) return parseRtpAudioPacket(packet);

  if (packet && typeof packet === "object") {
    const parsed = packet as {
      header?: Partial<RtpAudioPacket["header"]>;
      payload?: unknown;
    };
    if (parsed.header && Buffer.isBuffer(parsed.payload)) {
      return {
        header: {
          payloadType: Number(parsed.header.payloadType ?? 0),
          marker: Boolean(parsed.header.marker),
          sequenceNumber: Number(parsed.header.sequenceNumber ?? 0),
          timestamp: Number(parsed.header.timestamp ?? 0),
          ssrc: Number(parsed.header.ssrc ?? 0),
        },
        payload: parsed.payload,
      };
    }
    // Some stacks nest the media payload one level down.
    const nested = (parsed as { payload?: { payload?: unknown } }).payload;
    if (Buffer.isBuffer(nested)) {
      return readRtpPacket(nested);
    }
  }
  return null;
}

/**
 * Unsubscribe helper.
 *
 * WebRTC stacks disagree on the name — werift returns `unSubscribe`, others
 * return `un` — and a peer connection may be injected, so both are accepted.
 */
function unsubscribe(
  subscription: { un?: () => void; unSubscribe?: () => void } | undefined,
): void {
  if (!subscription) return;
  if (typeof subscription.un === "function") subscription.un();
  else if (typeof subscription.unSubscribe === "function") subscription.unSubscribe();
}

/**
 * The default audio track factory, paired with {@link defaultPeerFactory}.
 */
async function defaultAudioTrackFactory(): Promise<() => MediaTrackLike> {
  let werift: typeof import("werift");
  try {
    werift = await import("werift");
  } catch (error) {
    throw new Error(
      "WebRTCTransport needs a WebRTC stack to create audio tracks. " +
        "Install `werift`, or pass `createPeerConnection` and `createAudioTrack`." +
        (error instanceof Error ? ` (${error.message})` : ""),
    );
  }
  return () =>
    new werift.MediaStreamTrack({ kind: "audio" }) as unknown as MediaTrackLike;
}

/**
 * Resolve the outbound track from a transceiver.
 *
 * The shape differs between stacks, so the media stream is unwrapped when the
 * transceiver exposes one.
 */
function resolveTrack(transceiver: unknown): MediaTrackLike | null {
  if (!transceiver || typeof transceiver !== "object") return null;
  const t = transceiver as {
    sender?: { track?: MediaTrackLike };
    receiver?: { track?: MediaTrackLike };
  };
  return t.sender?.track ?? t.receiver?.track ?? (transceiver as MediaTrackLike);
}

/**
 * The default peer connection factory.
 *
 * Resolved lazily with a dynamic import so that a deployment injecting its own
 * factory does not pull a WebRTC stack into the bundle, and so the package still
 * loads when one is absent. A static import would make the dependency
 * mandatory even for `type: "webrtc"` users who supply their own.
 */
async function defaultPeerFactory(): Promise<PeerConnectionFactory> {
  let werift: typeof import("werift");
  try {
    werift = await import("werift");
  } catch (error) {
    throw new Error(
      "WebRTCTransport needs a WebRTC stack. Install `werift`, or pass " +
        "`createPeerConnection` to supply your own." +
        (error instanceof Error ? ` (${error.message})` : ""),
    );
  }
  return (config) =>
    new werift.RTCPeerConnection({
      // PCMU only, and this is not a preference — it is the contract.
      //
      // The inbound path decodes G.711 and nothing else, so an answer that also
      // offered Opus would let a client pick Opus for its own send direction
      // and the agent would silently hear nothing. Narrowing the offer means a
      // conforming client has only one choice that works.
      codecs: { audio: [werift.usePCMU()], video: [] },
      ...config,
    }) as unknown as PeerConnectionLike;
}

/** Wait for ICE gathering, so a client can send one complete offer. */
async function waitForIceGathering(
  peer: PeerConnectionLike,
  timeoutMs: number,
): Promise<void> {
  const withEvents = peer as PeerConnectionLike & {
    iceGatheringState?: string;
    iceGatheringStateChange?: {
      subscribe(
        handler: (state: string) => void,
      ): { un?: () => void; unSubscribe?: () => void };
    };
  };

  if (withEvents.iceGatheringState === "complete") return;

  // A stack with no gathering-state API is not slow to gather — it has no
  // trickle phase to wait for. Blocking for the full timeout here would add
  // seconds to every single call for no benefit.
  if (!withEvents.iceGatheringStateChange?.subscribe) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe(subscription);
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();

    // Subscribing after the state is read above leaves a window in which
    // gathering could finish; re-check once the subscription is live.
    const subscription = withEvents.iceGatheringStateChange?.subscribe((state) => {
      if (state === "complete") done();
    });
    if (withEvents.iceGatheringState === "complete") done();
  });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // An SDP offer is a few KB. A body far larger than that is not an offer,
      // and buffering it would let one caller exhaust the process's memory.
      if (size > MAX_SIGNALING_BODY_BYTES) {
        reject(new Error("Signalling body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new Error("Body is not valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function portOf(server: Server): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : 0;
}

export function createWebRTCTransport(
  options?: WebRTCTransportOptions,
): WebRTCTransport {
  return new WebRTCTransport(options);
}
