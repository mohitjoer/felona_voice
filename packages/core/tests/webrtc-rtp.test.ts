import { describe, it, expect } from "vitest";
import {
  PcmuPacketizer,
  serializeRtpAudioPacket,
  parseRtpAudioPacket,
  randomSsrc,
  PCMU_PAYLOAD_TYPE,
  PCMU_CLOCK_RATE,
  SAMPLES_PER_FRAME,
  type RtpAudioPacket,
} from "../src/transport/rtp.js";
import { pcm16ToMulaw8k, mulaw8kToPcm16k } from "../src/telephony/codec.js";

const frame = (fill = 0x55) => Buffer.alloc(SAMPLES_PER_FRAME, fill);

describe("PCMU constants", () => {
  it("uses the static PCMU payload type at 8 kHz", () => {
    expect(PCMU_PAYLOAD_TYPE).toBe(0);
    expect(PCMU_CLOCK_RATE).toBe(8000);
  });

  it("uses a 20 ms frame", () => {
    expect(SAMPLES_PER_FRAME).toBe(160);
    expect((SAMPLES_PER_FRAME / PCMU_CLOCK_RATE) * 1000).toBe(20);
  });
});

describe("PcmuPacketizer", () => {
  it("emits nothing until a whole frame has arrived", () => {
    const p = new PcmuPacketizer();
    // A short chunk is held, not padded: a short frame reads as packet loss.
    expect(p.push(Buffer.alloc(100))).toEqual([]);
    expect(p.bufferedBytes).toBe(100);
  });

  it("emits one frame once 160 bytes have accumulated", () => {
    const p = new PcmuPacketizer();
    p.push(Buffer.alloc(100));
    const packets = p.push(Buffer.alloc(60));
    expect(packets).toHaveLength(1);
    expect(packets[0].payload).toHaveLength(160);
    expect(p.bufferedBytes).toBe(0);
  });

  it("emits several frames from one large chunk", () => {
    const p = new PcmuPacketizer();
    expect(p.push(Buffer.alloc(160 * 3 + 40))).toHaveLength(3);
  });

  it("advances the timestamp by one frame per packet", () => {
    const p = new PcmuPacketizer({ ssrc: 1, initialSequenceNumber: 100 });
    const packets = p.push(Buffer.alloc(SAMPLES_PER_FRAME * 3));
    expect(packets.map((x) => x.header.timestamp)).toEqual([0, 160, 320]);
    expect(packets.map((x) => x.header.sequenceNumber)).toEqual([100, 101, 102]);
  });

  it("wraps the sequence number at 16 bits", () => {
    const p = new PcmuPacketizer({ ssrc: 1, initialSequenceNumber: 65535 });
    const packets = p.push(Buffer.alloc(SAMPLES_PER_FRAME * 2));
    expect(packets[0].header.sequenceNumber).toBe(65535);
    expect(packets[1].header.sequenceNumber).toBe(0);
  });

  it("stamps the same ssrc on every packet", () => {
    const p = new PcmuPacketizer({ ssrc: 4242 });
    const packets = p.push(Buffer.alloc(SAMPLES_PER_FRAME * 2));
    expect(packets.every((x) => x.header.ssrc === 4242)).toBe(true);
  });

  it("sets the PCMU payload type and the marker bit", () => {
    const p = new PcmuPacketizer();
    const [packet] = p.push(frame());
    expect(packet.header.payloadType).toBe(PCMU_PAYLOAD_TYPE);
    expect(packet.header.marker).toBe(true);
  });

  it("flush() discards a partial frame, for barge-in", () => {
    const p = new PcmuPacketizer();
    p.push(Buffer.alloc(100));
    expect(p.bufferedBytes).toBe(100);
    p.flush();
    expect(p.bufferedBytes).toBe(0);
    // After a flush, a fresh frame is emitted rather than completed from the
    // stale bytes.
    expect(p.push(frame())).toHaveLength(1);
  });

  it("does not alias the caller's buffer", () => {
    const p = new PcmuPacketizer();
    const source = frame(1);
    const [packet] = p.push(source);
    source.fill(2);
    expect(packet.payload[0]).toBe(1);
  });

  it("generates non-zero, varied ssrcs", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomSsrc()));
    expect(values.size).toBeGreaterThan(40);
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("RTP serialization", () => {
  const packet: RtpAudioPacket = {
    header: {
      payloadType: 0,
      sequenceNumber: 0x1234,
      timestamp: 0xdeadbeef,
      ssrc: 0xcafebabe,
      marker: true,
    },
    payload: Buffer.from([1, 2, 3, 4]),
  };

  it("writes a 12-byte header with no CSRC list or extension", () => {
    const raw = serializeRtpAudioPacket(packet);
    expect(raw).toHaveLength(16);
    expect(raw[0]).toBe(0x80); // V=2, P=0, X=0, CC=0
    expect(raw[1]).toBe(0x80); // M=1, PT=0
  });

  it("round-trips the header and payload", () => {
    const parsed = parseRtpAudioPacket(serializeRtpAudioPacket(packet))!;
    expect(parsed.header).toEqual(packet.header);
    expect(Buffer.from(parsed.payload)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("clears the marker bit when it is not set", () => {
    const raw = serializeRtpAudioPacket({
      ...packet,
      header: { ...packet.header, marker: false },
    });
    expect(raw[1] & 0x80).toBe(0);
  });

  it("round-trips through the packetizer", () => {
    const p = new PcmuPacketizer({ ssrc: 99, initialSequenceNumber: 7 });
    const [sent] = p.push(frame(0xab));
    const parsed = parseRtpAudioPacket(serializeRtpAudioPacket(sent))!;
    expect(parsed.header.ssrc).toBe(99);
    expect(parsed.header.sequenceNumber).toBe(7);
    expect(parsed.payload).toHaveLength(SAMPLES_PER_FRAME);
    expect(parsed.payload[0]).toBe(0xab);
  });
});

describe("RTP parsing edge cases", () => {
  const base = serializeRtpAudioPacket({
    header: {
      payloadType: 0,
      sequenceNumber: 1,
      timestamp: 2,
      ssrc: 3,
      marker: false,
    },
    payload: Buffer.from([9, 9, 9, 9]),
  });

  it("rejects a runt packet", () => {
    expect(parseRtpAudioPacket(Buffer.alloc(11))).toBeNull();
  });

  it("rejects a non-RTP version", () => {
    const bad = Buffer.from(base);
    bad[0] = 0x40; // V=1
    expect(parseRtpAudioPacket(bad)).toBeNull();
  });

  it("skips the CSRC list", () => {
    // CC=2 -> two 4-byte contributing-source entries sit between the fixed
    // 12-byte header and the payload.
    const header = Buffer.from(base.subarray(0, 12));
    header[0] = 0x82;
    const raw = Buffer.concat([header, Buffer.alloc(8, 0), base.subarray(12)]);
    const parsed = parseRtpAudioPacket(raw)!;
    expect(parsed.payload).toHaveLength(4);
    expect(parsed.payload[0]).toBe(9);
  });

  it("skips a header extension", () => {
    // X=1: a 4-byte extension header (2-byte profile, 2-byte length in 32-bit
    // words) followed by that many words, before the payload.
    const header = Buffer.from(base.subarray(0, 12));
    header[0] = 0x90;
    const ext = Buffer.alloc(4);
    ext.writeUInt16BE(0xbede, 0); // profile
    ext.writeUInt16BE(1, 2); // one 32-bit word follows
    const raw = Buffer.concat([
      header,
      ext,
      Buffer.alloc(4, 0), // the extension word
      base.subarray(12),
    ]);
    const parsed = parseRtpAudioPacket(raw)!;
    expect(parsed.payload).toHaveLength(4);
    expect(parsed.payload[0]).toBe(9);
  });

  it("skips a multi-word header extension", () => {
    const header = Buffer.from(base.subarray(0, 12));
    header[0] = 0x90;
    const ext = Buffer.alloc(4);
    ext.writeUInt16BE(0xbede, 0);
    ext.writeUInt16BE(3, 2);
    const raw = Buffer.concat([header, ext, Buffer.alloc(12, 0), base.subarray(12)]);
    expect(parseRtpAudioPacket(raw)!.payload).toHaveLength(4);
  });

  it("strips padding declared in the last byte", () => {
    // P=1, with the final byte giving the pad length in bytes, itself included.
    const header = Buffer.from(base.subarray(0, 12));
    header[0] = 0xa0;
    const raw = Buffer.concat([
      header,
      base.subarray(12),
      Buffer.from([0, 2]), // one filler byte plus the length byte
    ]);
    const parsed = parseRtpAudioPacket(raw)!;
    expect(parsed.payload).toHaveLength(4);
    expect(parsed.payload[0]).toBe(9);
  });

  it("ignores an impossible pad length rather than truncating payload", () => {
    const bogus = Buffer.concat([base, Buffer.from([200])]);
    const parsed = parseRtpAudioPacket(bogus)!;
    expect(parsed.payload).toHaveLength(5);
  });
});

describe("codec interop", () => {
  it("round-trips speech-shaped audio through the WebRTC encode path", () => {
    // A 440 Hz tone at 16 kHz, which is what TTS actually hands us.
    const sampleRate = 16000;
    const ms = 20; // exactly one 20 ms frame
    const samples = (sampleRate * ms) / 1000;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      pcm.writeInt16LE(
        Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
        i * 2,
      );
    }

    const mulaw = pcm16ToMulaw8k(pcm, sampleRate);
    // 16 kHz -> 8 kHz halves the sample count, and mu-law is 1 byte per sample.
    expect(mulaw).toHaveLength(samples / 2);

    const packetizer = new PcmuPacketizer();
    const packets = packetizer.push(mulaw);
    expect(packets).toHaveLength(1);

    // 160 mu-law bytes -> 160 samples at 8 kHz -> 320 samples at 16 kHz.
    const back = mulaw8kToPcm16k(packets[0].payload);
    expect(back).toHaveLength(SAMPLES_PER_FRAME * 4);

    // G.711 is lossy, so compare energy rather than samples: the point is that
    // the signal survives, not that it is bit-exact.
    let peak = 0;
    for (let i = 0; i < back.length; i += 2) {
      peak = Math.max(peak, Math.abs(back.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(3000);
  });

  it("keeps audio flowing across many chunks", () => {
    const packetizer = new PcmuPacketizer();
    // 20 ms of 16 kHz PCM per chunk, which is what a TTS stream produces.
    const chunk = Buffer.alloc(16000 * 2 * 0.02);
    let frames = 0;
    for (let i = 0; i < 10; i++) {
      frames += packetizer.push(pcm16ToMulaw8k(chunk, 16000)).length;
    }
    expect(frames).toBe(10);
  });
});
