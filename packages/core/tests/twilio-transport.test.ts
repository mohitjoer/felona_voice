import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  TwilioTransport,
  createTwilioTransport,
  createTwilioStreamTwiML,
  createTelnyxStreamTeXML,
  createAgent,
  AudioChunk,
  Session,
} from "../src/index.js";

// Mock WebSocket class for testing
class MockWebSocket extends EventEmitter {
  public readyState = 1; // WebSocket.OPEN
  public sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit("close");
  }
}

describe("Telephony TwiML Helpers", () => {
  it("generates valid Twilio Media Stream TwiML XML", () => {
    const xml = createTwilioStreamTwiML({
      streamUrl: "wss://voice.example.com/media",
      greeting: "Hello, thank you for calling!",
      customParameters: {
        customerId: "CUST-99",
        priority: "high",
      },
    });

    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<Say>Hello, thank you for calling!</Say>`);
    expect(xml).toContain(`<Stream url="wss://voice.example.com/media">`);
    expect(xml).toContain(`<Parameter name="customerId" value="CUST-99" />`);
    expect(xml).toContain(`<Parameter name="priority" value="high" />`);
    expect(xml).toContain(`</Connect>`);
  });

  it("escapes special XML characters in greetings and parameters", () => {
    const xml = createTwilioStreamTwiML({
      streamUrl: "wss://voice.example.com/media?foo=1&bar=2",
      greeting: "AT&T & 'Quotes' <Tag>",
      customParameters: {
        query: "a < b & c > d",
      },
    });

    expect(xml).toContain("wss://voice.example.com/media?foo=1&amp;bar=2");
    expect(xml).toContain("AT&amp;T &amp; &apos;Quotes&apos; &lt;Tag&gt;");
    expect(xml).toContain('value="a &lt; b &amp; c &gt; d"');
  });

  it("generates Telnyx TeXML identically", () => {
    const xml = createTelnyxStreamTeXML({
      streamUrl: "wss://telnyx.example.com/stream",
    });
    expect(xml).toContain(`<Stream url="wss://telnyx.example.com/stream">`);
  });
});

describe("TwilioTransport", () => {
  it("processes incoming Twilio Media Stream protocol end-to-end", async () => {
    const transport = new TwilioTransport({ port: 0 });
    const mockWs = new MockWebSocket();

    let connectedSession: Session | null = null;
    let disconnectedSession: Session | null = null;
    const receivedChunks: AudioChunk[] = [];

    transport.onConnect((session) => {
      connectedSession = session;
    });

    transport.onDisconnect((session) => {
      disconnectedSession = session;
    });

    transport.onAudioChunk((sessionId, chunk) => {
      receivedChunks.push(chunk);
    });

    // Attach mock WebSocket
    transport.handleWebSocket(mockWs as any);

    // 1. Send Twilio "connected" event
    mockWs.emit("message", JSON.stringify({
      event: "connected",
      protocol: "Call",
      version: "1.0.0",
    }));

    // 2. Send Twilio "start" event
    mockWs.emit("message", JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      start: {
        streamSid: "MZ_STREAM_12345",
        accountSid: "AC_TEST_ACCOUNT",
        callSid: "CA_TEST_CALL",
        tracks: ["inbound"],
        customParameters: {
          From: "+15550001111",
          To: "+15552223333",
          caller: "+15550001111",
        },
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          channels: 1,
        },
      },
      streamSid: "MZ_STREAM_12345",
    }));

    expect(connectedSession).not.toBeNull();
    expect(connectedSession!.id).toBe("MZ_STREAM_12345");
    expect(connectedSession!.metadata.telephony).toBe("twilio");
    expect(connectedSession!.metadata.callSid).toBe("CA_TEST_CALL");
    expect(connectedSession!.metadata.from).toBe("+15550001111");
    expect(connectedSession!.metadata.to).toBe("+15552223333");
    expect(transport.activeSessionCount).toBe(1);

    // 3. Send Twilio "media" event (8kHz μ-law chunk encoded in base64)
    // 4 bytes of 0xff (silence in μ-law)
    const base64Silence = Buffer.from([0xff, 0xff, 0xff, 0xff]).toString("base64");

    mockWs.emit("message", JSON.stringify({
      event: "media",
      sequenceNumber: "2",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "100",
        payload: base64Silence,
      },
      streamSid: "MZ_STREAM_12345",
    }));

    expect(receivedChunks.length).toBe(1);
    expect(receivedChunks[0].sampleRate).toBe(16000); // automatically upsampled to 16kHz for STT/VAD
    expect(receivedChunks[0].data.length).toBe(16); // 4 samples * 2x upsample * 2 bytes = 16 bytes

    // 4. Send audio back to Twilio (e.g. from TTS)
    const ttsLinear16 = Buffer.alloc(32); // 16 samples of 16kHz linear PCM
    await transport.sendAudio("MZ_STREAM_12345", {
      data: ttsLinear16,
      sampleRate: 16000,
      channels: 1,
      bitDepth: 16,
      timestampMs: 0,
    });

    expect(mockWs.sentMessages.length).toBe(1);
    const sentMsg = JSON.parse(mockWs.sentMessages[0]);
    expect(sentMsg.event).toBe("media");
    expect(sentMsg.streamSid).toBe("MZ_STREAM_12345");
    expect(typeof sentMsg.media.payload).toBe("string");

    // 5. Trigger barge-in clear event
    await transport.clearAudio("MZ_STREAM_12345");
    expect(mockWs.sentMessages.length).toBe(2);
    const clearMsg = JSON.parse(mockWs.sentMessages[1]);
    expect(clearMsg.event).toBe("clear");
    expect(clearMsg.streamSid).toBe("MZ_STREAM_12345");

    // 6. Send mark event
    await transport.sendMark("MZ_STREAM_12345", "first_sentence");
    expect(mockWs.sentMessages.length).toBe(3);
    const markMsg = JSON.parse(mockWs.sentMessages[2]);
    expect(markMsg.event).toBe("mark");
    expect(markMsg.mark.name).toBe("first_sentence");

    // 7. Send Twilio "stop" event
    mockWs.emit("message", JSON.stringify({
      event: "stop",
      sequenceNumber: "5",
      stop: {
        accountSid: "AC_TEST_ACCOUNT",
        callSid: "CA_TEST_CALL",
      },
      streamSid: "MZ_STREAM_12345",
    }));

    expect(disconnectedSession).not.toBeNull();
    expect(disconnectedSession!.id).toBe("MZ_STREAM_12345");
    expect(transport.activeSessionCount).toBe(0);
  });
});

describe("AgentBuilder Telephony Support", () => {
  it("configures Twilio transport via .twilio() builder API", () => {
    const builder = createAgent("PhoneReceptionist")
      .system("You are a phone receptionist.")
      .action("book_appointment", "Book or schedule an appointment", "I can help schedule your appointment.")
      .twilio({
        port: 8090,
        path: "/custom-stream",
        greeting: "Welcome to Acme Medical. How can I help you?",
      });

    const agent = builder.build();
    expect(agent).toBeDefined();
    expect(typeof (agent as any).listenTwilio).toBe("function");
    expect(typeof (agent as any).createTwilioTwiML).toBe("function");
  });
});
