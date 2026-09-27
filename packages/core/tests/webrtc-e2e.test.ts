/**
 * End-to-end WebRTC test against the real media stack.
 *
 * The unit tests drive a fake peer connection, which proves the signalling and
 * packetization logic but says nothing about whether audio actually crosses a
 * network. This one negotiates a real ICE/DTLS session between two peers on
 * loopback, then checks that speech travels in both directions and comes back
 * as decodable PCM rather than silence.
 *
 * It needs a usable loopback interface. Where there is not one, the test skips
 * rather than failing — a sandbox with no network is not a WebRTC bug.
 */

import { describe, it, expect, afterAll } from "vitest";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket } from "werift";
import { WebRTCTransport } from "../src/transport/webrtc.js";
import { pcm16ToMulaw8k, mulaw8kToPcm16k } from "../src/telephony/codec.js";

/** 20 ms of a 440 Hz tone at 16 kHz — speech-shaped, and cheap to generate. */
function tone(ms = 20): Buffer {
  const samples = (16000 * ms) / 1000;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(
      Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
      i * 2,
    );
  }
  return pcm;
}

function peakAmplitude(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  }
  return peak;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (predicate()) return true;
    await wait(100);
  }
  return predicate();
}

/** Loopback ICE needs a usable interface; without one there is nothing to test. */
async function loopbackWorks(): Promise<boolean> {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  try {
    a.addTransceiver(new MediaStreamTrack({ kind: "audio" }));
    b.addTransceiver(new MediaStreamTrack({ kind: "audio" }));
    const offer = await b.createOffer();
    await b.setLocalDescription(offer);
    await a.setRemoteDescription(offer);
    const answer = await a.createAnswer();
    await a.setLocalDescription(answer);
    await b.setRemoteDescription(a.localDescription as never);

    let connected = false;
    b.connectionStateChange.subscribe((s: string) => {
      if (s === "connected") connected = true;
    });
    return await waitFor(() => connected, 8000);
  } catch {
    return false;
  } finally {
    // Both peers hold UDP sockets; leaving them open keeps the test runner alive.
    a.close();
    b.close();
  }
}

describe("WebRTC end-to-end (real media stack)", () => {
  let available: boolean | null = null;
  const transports: WebRTCTransport[] = [];
  const openPeers: RTCPeerConnection[] = [];

  afterAll(async () => {
    for (const t of transports) await t.stop();
    for (const p of openPeers) p.close();
  });

  it("carries audio in both directions over a real peer connection", async () => {
    if (available === null) available = await loopbackWorks();
    if (!available) {
      // Not a WebRTC failure: this environment cannot complete ICE at all.
      console.warn("[webrtc] skipping: no usable loopback ICE in this environment");
      return;
    }

    const transport = new WebRTCTransport({});
    transports.push(transport);

    let inboundChunks = 0;
    let inboundPeak = 0;
    transport.onAudioChunk((_id, chunk) => {
      inboundChunks++;
      inboundPeak = Math.max(inboundPeak, peakAmplitude(chunk.data));
    });

    await transport.start({ port: 0, host: "127.0.0.1" });
    const port = transport.serverAddress;
    expect(port).toBeGreaterThan(0);

    // The client side, as a browser would behave.
    const caller = new RTCPeerConnection({ iceServers: [] });
    openPeers.push(caller);
    const clientTrack = new MediaStreamTrack({ kind: "audio" });
    caller.addTransceiver(clientTrack, { direction: "sendrecv" });

    let outboundPackets = 0;
    let outboundBytes = 0;
    let firstOutbound: Buffer | null = null;
    caller.onTrack.subscribe((remote: never) => {
      const track = remote as unknown as {
        onReceiveRtp: {
          subscribe(h: (p: { payload: Buffer }) => void): unknown;
        };
      };
      track.onReceiveRtp.subscribe((p) => {
        outboundPackets++;
        outboundBytes += p.payload.length;
        if (!firstOutbound) firstOutbound = Buffer.from(p.payload);
      });
    });

    const offer = await caller.createOffer();
    await caller.setLocalDescription(offer);

    const response = await fetch(`http://127.0.0.1:${port}/offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, type: "offer" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessionId: string;
      answer: { sdp: string; type: string };
    };

    // Only PCMU may be offered: the inbound path decodes G.711 and nothing
    // else, so an answer advertising Opus would let a client send Opus and the
    // agent would hear nothing.
    expect(body.answer.sdp).toContain("PCMU/8000");
    expect(body.answer.sdp).not.toContain("OPUS");

    await caller.setRemoteDescription(body.answer);

    let connected = false;
    caller.connectionStateChange.subscribe((s: string) => {
      if (s === "connected") connected = true;
    });
    expect(await waitFor(() => connected, 15000)).toBe(true);

    // Agent -> caller.
    const pcm = tone();
    for (let i = 0; i < 25; i++) {
      await transport.sendAudio(body.sessionId, {
        data: pcm,
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        timestampMs: i * 20,
      });
      await wait(20);
    }
    await waitFor(() => outboundPackets >= 25, 5000);

    // 25 frames of 160 mu-law bytes each, with none lost.
    expect(outboundPackets).toBe(25);
    expect(outboundBytes).toBe(25 * 160);

    // The bytes on the wire really are audio, not a correctly shaped silence.
    const decoded = mulaw8kToPcm16k(firstOutbound as unknown as Buffer);
    expect(peakAmplitude(decoded)).toBeGreaterThan(2000);

    // Caller -> agent, as a PCMU client.
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 0x00; // PCMU
    header.writeUInt16BE(1, 2);
    header.writeUInt32BE(0, 4);
    header.writeUInt32BE(555, 8);
    const frame = pcm16ToMulaw8k(pcm, 16000);

    for (let i = 0; i < 10; i++) {
      clientTrack.writeRtp(RtpPacket.deSerialize(Buffer.concat([header, frame])));
      await wait(25);
    }

    expect(await waitFor(() => inboundChunks > 0, 5000)).toBe(true);
    expect(inboundPeak).toBeGreaterThan(2000);

    caller.close();
    await transport.stop();
  }, 60000);
});
