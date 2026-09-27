/**
 * RTP packetization for G.711 audio on a WebRTC track.
 *
 * WebRTC's audio path is RTP, not a byte stream, so something has to chop the
 * agent's PCM output into correctly-timed packets with monotonic sequence
 * numbers and timestamps. Getting that wrong is not a crash — it is audio that
 * arrives at the wrong speed, clicks, or is silently dropped by jitter
 * buffers, which is why it lives here with its own tests rather than inline in
 * the transport.
 *
 * PCMU is used rather than Opus for a reason specific to this framework: it is
 * the one codec where the wire format is a pure function of the sample, so the
 * same G.711 code the telephony path already uses converts in both directions
 * with no encoder state, no lookahead, and no per-stream priming. For speech at
 * 8 kHz the quality cost is acceptable and the CPU cost is negligible.
 */

/** PCMU is a static payload type; no SDP negotiation is needed for it. */
export const PCMU_PAYLOAD_TYPE = 0;

/** PCMU clock rate. Samples are bytes, so 1 byte = 1 sample. */
export const PCMU_CLOCK_RATE = 8000;

/** Samples in one 20 ms frame at 8 kHz — the frame size every browser expects. */
export const SAMPLES_PER_FRAME = (PCMU_CLOCK_RATE * 20) / 1000; // 160

/** A packetized audio frame, ready to hand to a track. */
export interface RtpAudioPacket {
  header: {
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    marker: boolean;
  };
  /** μ-law encoded samples, one byte each. */
  payload: Buffer;
}

/**
 * Accumulates μ-law bytes and emits whole 20 ms frames.
 *
 * Audio arrives from the pipeline in whatever sizes the TTS provider produces,
 * which almost never matches the 160-byte frame the wire wants. A partial frame
 * is held rather than padded, because sending a short frame makes the receiver's
 * jitter buffer interpret the gap as packet loss.
 */
export class PcmuPacketizer {
  private buffer: Buffer = Buffer.alloc(0);
  private sequenceNumber: number;
  private timestamp = 0;
  private readonly ssrc: number;

  constructor(options: { ssrc?: number; initialSequenceNumber?: number } = {}) {
    // Sequence numbers and SSRCs must be unpredictable per RFC 3550, and a
    // fixed value across sessions makes traffic trivially fingerprintable.
    this.ssrc = options.ssrc ?? randomSsrc();
    this.sequenceNumber =
      options.initialSequenceNumber ?? Math.floor(Math.random() * 0xffff);
  }

  /** The SSRC this packetizer stamps on every packet. */
  get mediaSsrc(): number {
    return this.ssrc;
  }

  /** Frames buffered but not yet emitted. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /**
   * Feed μ-law bytes and take whatever whole frames are now available.
   *
   * Returns an empty array when less than a frame has accumulated, which is the
   * normal case for a chunk smaller than 20 ms.
   */
  push(mulaw: Buffer): RtpAudioPacket[] {
    this.buffer =
      this.buffer.length === 0 ? mulaw : Buffer.concat([this.buffer, mulaw]);

    const packets: RtpAudioPacket[] = [];
    while (this.buffer.length >= SAMPLES_PER_FRAME) {
      const payload = this.buffer.subarray(0, SAMPLES_PER_FRAME);
      this.buffer = this.buffer.subarray(SAMPLES_PER_FRAME);

      packets.push({
        header: {
          payloadType: PCMU_PAYLOAD_TYPE,
          sequenceNumber: this.sequenceNumber & 0xffff,
          timestamp: this.timestamp >>> 0,
          ssrc: this.ssrc,
          // One packet per talkspurt frame: the marker bit tells the receiver
          // this starts a new burst of audio, which suppresses its comfort
          // noise while the agent is speaking.
          marker: true,
        },
        payload: Buffer.from(payload),
      });

      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;
    }
    return packets;
  }

  /**
   * Discard buffered audio.
   *
   * Called on barge-in: audio queued before the caller started talking is
   * already stale, and sending it would talk over them.
   */
  flush(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * A non-zero 32-bit SSRC.
 *
 * Zero is reserved, and a constant SSRC across sessions would let an observer
 * link separate calls together, so this is randomised per stream.
 */
export function randomSsrc(): number {
  // 2^32 - 1 keeps the value inside the unsigned 32-bit RTP field.
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * Serialize a packetized frame to the bytes that go on the wire.
 *
 * Written by hand rather than via a dependency's packet builder so the RTP
 * header layout is visible and testable at this layer: 12 bytes, no CSRC list,
 * no header extension.
 */
export function serializeRtpAudioPacket(packet: RtpAudioPacket): Buffer {
  const { header, payload } = packet;
  const out = Buffer.allocUnsafe(12 + payload.length);

  // byte 0: V=2 (RFC 3550), P=0, X=0, CC=0
  out[0] = 0x80;
  // byte 1: M + payload type (7 bits)
  out[1] = (header.marker ? 0x80 : 0x00) | (header.payloadType & 0x7f);
  out.writeUInt16BE(header.sequenceNumber & 0xffff, 2);
  out.writeUInt32BE(header.timestamp >>> 0, 4);
  out.writeUInt32BE(header.ssrc >>> 0, 8);
  payload.copy(out, 12);

  return out;
}

/** Parse the fields of an inbound PCMU packet. */
export function parseRtpAudioPacket(raw: Buffer): RtpAudioPacket | null {
  if (raw.length < 12) return null;

  const version = (raw[0] >> 6) & 0x03;
  // Only RTP version 2 is defined; anything else is not audio we can use.
  if (version !== 2) return null;

  const padding = ((raw[0] >> 5) & 0x01) === 1;
  const extension = ((raw[0] >> 4) & 0x01) === 1;
  const csrcCount = raw[0] & 0x0f;
  const marker = ((raw[1] >> 7) & 0x01) === 1;
  const payloadType = raw[1] & 0x7f;

  let offset = 12 + csrcCount * 4;
  if (extension) {
    // The extension header is 4 bytes plus one length word (in 32-bit units).
    if (raw.length < offset + 4) return null;
    const extensionWords = raw.readUInt16BE(offset + 2);
    offset += 4 + extensionWords * 4;
  }

  let end = raw.length;
  if (padding && end > offset) {
    // The final byte counts the padding, padding itself included.
    const padLength = raw[end - 1];
    if (padLength > 0 && padLength <= end - offset) end -= padLength;
  }

  if (offset > end) return null;

  return {
    header: {
      payloadType,
      marker,
      sequenceNumber: raw.readUInt16BE(2),
      timestamp: raw.readUInt32BE(4),
      ssrc: raw.readUInt32BE(8),
    },
    payload: raw.subarray(offset, end),
  };
}
