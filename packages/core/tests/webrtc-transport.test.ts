import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import {
  WebRTCTransport,
  createWebRTCTransport,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type MediaTrackLike,
} from "../src/transport/webrtc.js";
import { SAMPLES_PER_FRAME } from "../src/transport/rtp.js";
import type { AudioChunk, Session } from "../src/types.js";

/**
 * A peer connection that records what it was told and hands back a track the
 * test can push RTP into.
 *
 * Exercising the signalling path against a real WebRTC stack would need a real
 * peer on the other end; what matters here is that the transport does the right
 * thing with an offer, an answer, and the audio in between.
 */
function fakePeer() {
  const written: Buffer[] = [];
  const listeners: Array<(packet: { payload: Buffer }) => void> = [];
  let closed = false;
  let remoteDescription: { type: string; sdp: string } | null = null;
  const stateListeners: Array<(state: string) => void> = [];

  const track: MediaTrackLike = {
    writeRtp: (packet) => {
      written.push(packet as Buffer);
    },
    onReceiveRtp: {
      subscribe: (handler) => {
        listeners.push(handler);
        return { un: () => undefined };
      },
    },
  };

  const peer: PeerConnectionLike & {
    feed: (payload: Buffer) => void;
    feedParsed: (parsed: unknown) => void;
    emitState: (state: string) => void;
    isClosed: () => boolean;
  } = {
    addTransceiver: () => ({ sender: { track } }),
    setRemoteDescription: async (description) => {
      remoteDescription = description;
    },
    createAnswer: async () => ({
      type: "answer",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
    }),
    localDescription: null,
    close: () => {
      closed = true;
    },
    onConnectionStateChange: {
      subscribe: (handler) => {
        stateListeners.push(handler);
        return { un: () => undefined };
      },
    },
    feed: (payload: Buffer) => listeners.forEach((h) => h({ payload })),
    feedParsed: (parsed: unknown) => listeners.forEach((h) => h(parsed as never)),
    emitState: (state: string) => stateListeners.forEach((h) => h(state)),
    isClosed: () => closed,
    get remoteDescription() {
      return remoteDescription;
    },
  } as never;

  return { peer, written, track };
}

interface Harness {
  transport: WebRTCTransport;
  base: string;
  port: number;
  peers: ReturnType<typeof fakePeer>[];
  connections: Session[];
  disconnects: Session[];
  chunks: Array<{ sessionId: string; chunk: AudioChunk }>;
  factory: PeerConnectionFactory;
}

const running: Array<{ transport: WebRTCTransport; server: Server }> = [];

async function harness(
  options: Partial<ConstructorParameters<typeof WebRTCTransport>[0]> = {},
): Promise<Harness> {
  const peers: ReturnType<typeof fakePeer>[] = [];
  const connections: Session[] = [];
  const disconnects: Session[] = [];
  const chunks: Array<{ sessionId: string; chunk: AudioChunk }> = [];

  const factory: PeerConnectionFactory = () => {
    const created = fakePeer();
    peers.push(created);
    return created.peer;
  };

  const transport = createWebRTCTransport({ createPeerConnection: factory, ...options });
  transport.onConnect((s) => connections.push(s));
  transport.onDisconnect((s) => disconnects.push(s));
  transport.onAudioChunk((sessionId, chunk) => chunks.push({ sessionId, chunk }));

  // Port 0 lets the OS pick a free port, so tests never collide.
  const server = createServer();
  await transport.start({ port: 0, server: server as never });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  running.push({ transport, server });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return { transport, base: `http://127.0.0.1:${port}`, port, peers, connections, disconnects, chunks, factory };
}

/** 20 ms of 16 kHz PCM, which is one WebRTC frame. */
function audioChunk(ms = 20): AudioChunk {
  const samples = (16000 * ms) / 1000;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  }
  return { data, sampleRate: 16000, channels: 1, bitDepth: 16, timestampMs: 0 };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close", ...headers },
    body: JSON.stringify(body),
  });
}

const OFFER = { sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n", type: "offer" };

afterEach(async () => {
  for (const { transport, server } of running.splice(0)) {
    await transport.stop();
    // `fetch` keeps its connection alive, and close() waits for open sockets, so
    // the server has to be told to drop them or this never resolves.
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

describe("WebRTCTransport signalling", () => {
  it("answers an offer and registers a session", async () => {
    const h = await harness();

    const res = await post(h.base, "/offer", OFFER);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { sessionId: string; answer: { sdp: string } };
    expect(body.sessionId).toBeTruthy();
    expect(body.answer.sdp).toContain("v=0");

    expect(h.transport.activeSessionCount).toBe(1);
    expect(h.connections).toHaveLength(1);
    expect(h.transport.getSession(body.sessionId)?.state).toBe("active");
    // The offer is what the client sent, not something invented.
    expect(h.peers[0].peer.remoteDescription).toMatchObject({ type: "offer" });
  });

  it("rejects an offer with no sdp", async () => {
    const h = await harness();
    const res = await post(h.base, "/offer", { type: "offer" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing `sdp`/);
    expect(h.transport.activeSessionCount).toBe(0);
  });

  it("rejects a non-JSON body", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/offer`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: "not json",
    });
    expect(res.status).toBe(500);
  });

  it("rejects GET on the offer endpoint", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/offer`, { headers: { connection: "close" } });
    expect(res.status).toBe(405);
  });

  it("404s an unknown path", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/nope`, { headers: { connection: "close" } });
    expect(res.status).toBe(404);
  });

  it("accepts a custom signalling path", async () => {
    const h = await harness({ path: "/rtc/offer" });
    expect((await post(h.base, "/rtc/offer", OFFER)).status).toBe(200);
    expect((await post(h.base, "/offer", OFFER)).status).toBe(404);
  });

  it("reports a peer that cannot produce an answer without leaking a session", async () => {
    const peers: Array<ReturnType<typeof fakePeer>> = [];
    const transport = createWebRTCTransport({
      createPeerConnection: () => {
        const p = fakePeer();
        (p.peer as { createAnswer: unknown }).createAnswer = async () => null;
        peers.push(p);
        return p.peer;
      },
    });
    const server = createServer();
    await transport.start({ port: 0, server: server as never });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    running.push({ transport, server });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await post(`http://127.0.0.1:${port}`, "/offer", OFFER);
    expect(res.status).toBe(500);
    expect(transport.activeSessionCount).toBe(0);
    expect(peers[0].peer.isClosed()).toBe(true);
  });
});

describe("WebRTCTransport authentication", () => {
  it("rejects an unauthenticated offer", async () => {
    const h = await harness({ authToken: "s3cret" });
    const res = await post(h.base, "/offer", OFFER);
    expect(res.status).toBe(401);
    expect(h.transport.activeSessionCount).toBe(0);
  });

  it("accepts a bearer token", async () => {
    const h = await harness({ authToken: "s3cret" });
    const res = await post(h.base, "/offer", OFFER, {
      authorization: "Bearer s3cret",
    });
    expect(res.status).toBe(200);
  });

  it("accepts a query token", async () => {
    const h = await harness({ authToken: "s3cret" });
    const res = await post(h.base, "/offer?token=s3cret", OFFER);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token", async () => {
    const h = await harness({ authToken: "s3cret" });
    expect((await post(h.base, "/offer", OFFER, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("guards the ICE endpoint too", async () => {
    const h = await harness({ authToken: "s3cret" });
    const res = await post(h.base, "/offer/ice", { sessionId: "x" });
    expect(res.status).toBe(401);
  });

  it("honours a custom verifyClient over the token", async () => {
    const h = await harness({
      authToken: "s3cret",
      verifyClient: (req) => req.headers["x-ok"] === "1",
    });
    expect(
      (await post(h.base, "/offer", OFFER, { "x-ok": "1" })).status,
    ).toBe(200);
  });

  it("treats a throwing verifyClient as a rejection", async () => {
    const h = await harness({
      verifyClient: () => {
        throw new Error("boom");
      },
    });
    expect((await post(h.base, "/offer", OFFER)).status).toBe(401);
  });
});

describe("WebRTCTransport capacity", () => {
  it("refuses calls past maxConnections", async () => {
    const h = await harness({ maxConnections: 1 });
    expect((await post(h.base, "/offer", OFFER)).status).toBe(200);
    const second = await post(h.base, "/offer", OFFER);
    expect(second.status).toBe(503);
    expect((await second.json()).error).toMatch(/At capacity/);
    expect(h.transport.activeSessionCount).toBe(1);
  });

  it("frees the slot when a call ends", async () => {
    const h = await harness({ maxConnections: 1 });
    const first = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };
    expect((await post(h.base, "/offer", OFFER)).status).toBe(503);

    h.peers[0].peer.emitState("closed");
    expect(h.transport.activeSessionCount).toBe(0);
    expect(h.disconnects.map((s) => s.id)).toContain(first.sessionId);

    expect((await post(h.base, "/offer", OFFER)).status).toBe(200);
  });
});

describe("WebRTCTransport audio", () => {
  it("packetizes outbound audio into 20 ms PCMU frames", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };

    await h.transport.sendAudio(sessionId, audioChunk(20));
    expect(h.peers[0].written).toHaveLength(1);

    await h.transport.sendAudio(sessionId, audioChunk(20));
    expect(h.peers[0].written).toHaveLength(2);
  });

  it("holds a partial frame rather than sending a short one", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };

    // 10 ms is half a frame: nothing goes on the wire yet.
    await h.transport.sendAudio(sessionId, audioChunk(10));
    expect(h.peers[0].written).toHaveLength(0);

    // The next 10 ms completes it.
    await h.transport.sendAudio(sessionId, audioChunk(10));
    expect(h.peers[0].written).toHaveLength(1);
  });

  it("throws for an unknown session", async () => {
    const h = await harness();
    await expect(h.transport.sendAudio("nope", audioChunk())).rejects.toThrow(
      /not found/,
    );
  });

  it("survives a track that throws on write", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };
    h.peers[0].track.writeRtp = () => {
      throw new Error("track closed");
    };
    const errors: Error[] = [];
    h.transport.on("transportError", (e: Error) => errors.push(e));

    // A dead track must not take down the call loop.
    await expect(h.transport.sendAudio(sessionId, audioChunk())).resolves.toBeUndefined();
    expect(errors[0]?.message).toMatch(/Failed to write RTP/);
  });

  it("clearAudio drops queued audio for barge-in", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };

    await h.transport.sendAudio(sessionId, audioChunk(10));
    await h.transport.clearAudio(sessionId);
    await h.transport.sendAudio(sessionId, audioChunk(10));
    // The first 10 ms was discarded, so the second only completes a half frame.
    expect(h.peers[0].written).toHaveLength(0);

    await h.transport.sendAudio(sessionId, audioChunk(10));
    expect(h.peers[0].written).toHaveLength(1);
  });

  it("emits inbound RTP as 16 kHz PCM chunks", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };

    // A well-formed PCMU packet carrying one frame.
    const payload = Buffer.alloc(SAMPLES_PER_FRAME, 0x7f);
    const rtp = Buffer.alloc(12 + payload.length);
    rtp[0] = 0x80;
    rtp[1] = 0x00;
    rtp.writeUInt16BE(1, 2);
    rtp.writeUInt32BE(0, 4);
    rtp.writeUInt32BE(1234, 8);
    payload.copy(rtp, 12);

    h.peers[0].peer.feed(rtp);

    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].sessionId).toBe(sessionId);
    expect(h.chunks[0].chunk.sampleRate).toBe(16000);
    expect(h.chunks[0].chunk.bitDepth).toBe(16);
    expect(h.chunks[0].chunk.data).toHaveLength(SAMPLES_PER_FRAME * 4);
  });

  it("accepts an already-parsed packet, as real stacks deliver", async () => {
    const h = await harness();
    await post(h.base, "/offer", OFFER);

    // Real WebRTC stacks hand a subscriber a parsed { header, payload }, not the
    // raw wire bytes. Treating that shape as wire bytes yields a garbage header
    // and the caller goes unheard, so both are accepted.
    h.peers[0].peer.feedParsed({
      header: {
        payloadType: 0,
        marker: true,
        sequenceNumber: 1,
        timestamp: 0,
        ssrc: 99,
      },
      payload: Buffer.alloc(SAMPLES_PER_FRAME, 0x7f),
    } as never);

    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0].chunk.data).toHaveLength(SAMPLES_PER_FRAME * 4);
  });

  it("ignores an unrecognised packet shape", async () => {
    const h = await harness();
    await post(h.base, "/offer", OFFER);
    h.peers[0].peer.feedParsed("nonsense" as never);
    h.peers[0].peer.feedParsed(null as never);
    h.peers[0].peer.feedParsed({} as never);
    expect(h.chunks).toHaveLength(0);
  });

  it("ignores a non-PCMU payload type rather than decoding noise", async () => {
    const h = await harness();
    await post(h.base, "/offer", OFFER);

    const payload = Buffer.alloc(SAMPLES_PER_FRAME, 0x7f);
    const rtp = Buffer.alloc(12 + payload.length);
    rtp[0] = 0x80;
    rtp[1] = 111; // Opus
    payload.copy(rtp, 12);

    h.peers[0].peer.feed(rtp);
    expect(h.chunks).toHaveLength(0);
  });

  it("stops emitting audio after the call ends", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };

    h.peers[0].peer.emitState("failed");
    h.peers[0].peer.feed(Buffer.alloc(12 + SAMPLES_PER_FRAME));
    expect(h.chunks).toHaveLength(0);
    // The session is released, not merely flagged, so the slot is reusable.
    expect(h.transport.getSession(sessionId)).toBeUndefined();
    expect(h.disconnects.map((s) => s.id)).toContain(sessionId);
    expect(h.disconnects[0].state).toBe("ended");
  });

  it("reports that there is no control channel", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };
    // Better an explicit failure than a sendMessage that appears to work.
    await expect(h.transport.sendMessage(sessionId, { a: 1 })).rejects.toThrow(
      /no data channel/,
    );
  });
});

describe("WebRTCTransport lifecycle", () => {
  it("ends every session on stop", async () => {
    const h = await harness();
    await post(h.base, "/offer", OFFER);
    await post(h.base, "/offer", OFFER);
    expect(h.transport.activeSessionCount).toBe(2);

    await h.transport.stop();
    expect(h.transport.activeSessionCount).toBe(0);
    expect(h.disconnects).toHaveLength(2);
    expect(h.peers.every((p) => p.peer.isClosed())).toBe(true);
  });

  it("opens and closes its own server when given none", async () => {
    // Port 0 lets the OS choose, so this cannot collide with anything.
    const transport = createWebRTCTransport({
      createPeerConnection: () => fakePeer().peer,
    });
    const connections: Session[] = [];
    transport.onConnect((s) => connections.push(s));

    await transport.start({ port: 0, host: "127.0.0.1" });
    const address = transport.serverAddress;
    expect(address).toBeGreaterThan(0);

    const res = await post(`http://127.0.0.1:${address}`, "/offer", OFFER);
    expect(res.status).toBe(200);
    expect(connections).toHaveLength(1);

    // stop() owns the server here, so it must actually be released.
    await transport.stop();
    await expect(
      fetch(`http://127.0.0.1:${address}/offer`, {
        method: "POST",
        headers: { connection: "close" },
        body: "{}",
      }),
    ).rejects.toThrow();
  });

  it("refuses to start twice", async () => {
    const h = await harness();
    await expect(h.transport.start({ port: 0 })).rejects.toThrow(/already started/);
  });

  it("stop() is safe to call when never started", async () => {
    const transport = createWebRTCTransport({
      createPeerConnection: () => fakePeer().peer,
    });
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it("stays quiet when no transportError listener exists", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };
    h.peers[0].track.writeRtp = () => {
      throw new Error("track closed");
    };
    // A bare 'error' emission would take the process down; this must not throw.
    await expect(h.transport.sendAudio(sessionId, audioChunk())).resolves.toBeUndefined();
  });
});

describe("ICE endpoint", () => {
  it("accepts a candidate for a known session", async () => {
    const h = await harness();
    const { sessionId } = (await (await post(h.base, "/offer", OFFER)).json()) as {
      sessionId: string;
    };
    const res = await post(h.base, "/offer/ice", {
      sessionId,
      candidate: { candidate: "candidate:1 1 udp 2 10.0.0.1 5000 typ host" },
    });
    expect(res.status).toBe(204);
  });

  it("404s an unknown session", async () => {
    const h = await harness();
    const res = await post(h.base, "/offer/ice", { sessionId: "nope" });
    expect(res.status).toBe(404);
  });

  it("400s a missing sessionId", async () => {
    const h = await harness();
    expect((await post(h.base, "/offer/ice", {})).status).toBe(400);
  });
});
