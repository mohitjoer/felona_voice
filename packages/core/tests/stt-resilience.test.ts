import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AudioBuffer, DEFAULT_MAX_BUFFERED_AUDIO_BYTES } from "../src/stt/audio-buffer.js";
import { WhisperSTT, createWhisperSTT } from "../src/stt/whisper.js";
import { GoogleSTT } from "../src/stt/google.js";
import { AzureSTT } from "../src/stt/azure.js";
import type { AudioChunk } from "../src/types.js";

function chunk(bytes: number): AudioChunk {
  return {
    data: Buffer.alloc(bytes, 1),
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    timestampMs: 0,
  };
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(impl as typeof fetch) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("AudioBuffer", () => {
  it("returns everything and resets", () => {
    const buf = new AudioBuffer();
    buf.push(Buffer.from([1, 2]));
    buf.push(Buffer.from([3, 4]));
    expect(buf.byteLength).toBe(4);
    expect([...buf.take()]).toEqual([1, 2, 3, 4]);
    expect(buf.byteLength).toBe(0);
    expect(buf.isEmpty).toBe(true);
  });

  it("stays within the cap instead of growing without bound", () => {
    const dropped: number[] = [];
    const buf = new AudioBuffer({ onDrop: (b) => dropped.push(b) });
    const chunk = Buffer.alloc(64 * 1024);
    for (let i = 0; i < 400; i++) buf.push(chunk);
    // 400 * 64KB = 25MB offered; the cap is ~1.9MB.
    expect(buf.byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BUFFERED_AUDIO_BYTES);
    expect(buf.dropped).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("keeps the most recent audio, not the oldest", () => {
    const buf = new AudioBuffer();
    const marker = Buffer.alloc(1024 * 1024);
    buf.push(Buffer.alloc(marker.length, 1));
    buf.push(Buffer.alloc(marker.length, 2));
    buf.push(Buffer.alloc(marker.length, 3));
    buf.push(Buffer.alloc(marker.length, 4));
    const kept = buf.take();
    // The newest chunk must survive; the oldest must be the thing dropped.
    expect(kept[kept.length - 1]).toBe(4);
    expect(kept.includes(1)).toBe(false);
  });

  it("keeps a single oversized chunk rather than looping forever", () => {
    const buf = new AudioBuffer();
    const huge = Buffer.alloc(DEFAULT_MAX_BUFFERED_AUDIO_BYTES + 1024, 7);
    buf.push(huge);
    expect(buf.byteLength).toBe(huge.length);
    expect(buf.take().length).toBe(huge.length);
  });

  it("clears without returning", () => {
    const buf = new AudioBuffer();
    buf.push(Buffer.alloc(10));
    buf.clear();
    expect(buf.isEmpty).toBe(true);
    expect(buf.take().length).toBe(0);
  });

  it("defaults to about a minute of audio", () => {
    expect(DEFAULT_MAX_BUFFERED_AUDIO_BYTES).toBe(60 * 16000 * 2);
  });
});

describe("batch STT providers", () => {
  let restore: () => void;

  beforeEach(() => { restore = stubFetch(async () => new Response("unused")); });
  afterEach(() => { restore(); });

  const providers = [
    { name: "whisper", make: () => createWhisperSTT({ apiKey: "k" }) },
    { name: "google", make: () => new GoogleSTT({ apiKey: "k" }) },
    { name: "azure", make: () => new AzureSTT({ apiKey: "k", region: "eastus" }) },
  ];

  for (const p of providers) {
    it(`${p.name}: recovers the flush queue after a failed transcription`, async () => {
      let call = 0;
      restore();
      restore = stubFetch(async () => {
        call++;
        // First request succeeds at the HTTP layer but the body is unusable,
        // which previously left the inFlight chain permanently rejected.
        if (call === 1) return new Response("not json", { status: 200 });
        return Response.json(transcriptBody(p.name));
      });

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError(() => {});

      stream.write(chunk(8000));
      await stream.flush();

      // A later turn must still work rather than rejecting forever.
      stream.write(chunk(8000));
      await expect(stream.flush()).resolves.toBeUndefined();
      expect(call).toBeGreaterThanOrEqual(2);
    });

    it(`${p.name}: bounds buffered audio under a continuous-speech flood`, async () => {
      const seen: number[] = [];
      restore();
      restore = stubFetch(async (_u, init) => {
        const body = init?.body as Uint8Array | undefined;
        seen.push(body?.byteLength ?? 0);
        return Response.json(transcriptBody(p.name));
      });

      const stream = p.make().createStream!();
      const errors: Error[] = [];
      stream.onResult(() => {});
      stream.onError((e) => errors.push(e));

      // 400 chunks * 64KB = 25MB offered into a provider with a 60s cap.
      for (let i = 0; i < 400; i++) stream.write(chunk(64 * 1024));
      await stream.flush();

      // The request body must be near the cap, not 25MB.
      expect(seen[0]).toBeLessThanOrEqual(DEFAULT_MAX_BUFFERED_AUDIO_BYTES + 65536);
      expect(errors.some((e) => /buffer cap/i.test(e.message))).toBe(true);
    });

    it(`${p.name}: sends the API key in a header, not the URL`, async () => {
      let url = "";
      let headers: Record<string, string> = {};
      restore();
      restore = stubFetch(async (u, init) => {
        url = u;
        headers = (init?.headers ?? {}) as Record<string, string>;
        return Response.json(transcriptBody(p.name));
      });

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError(() => {});
      stream.write(chunk(8000));
      await stream.flush();

      expect(url).not.toMatch(/[?&](key|api_?key|token)=/i);
      const authValues = Object.values(headers).join(" ");
      expect(authValues).not.toBe("");
    });

    it(`${p.name}: passes an abort signal so a hung request cannot wedge the turn`, async () => {
      let signal: AbortSignal | undefined;
      restore();
      restore = stubFetch(async (_u, init) => {
        signal = init?.signal ?? undefined;
        return Response.json(transcriptBody(p.name));
      });

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError(() => {});
      stream.write(chunk(8000));
      await stream.flush();

      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it(`${p.name}: surfaces a 401 as an actionable error rather than silence`, async () => {
      const errors: Error[] = [];
      restore();
      restore = stubFetch(async () => new Response("bad key", { status: 401 }));

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError((e) => errors.push(e));
      stream.write(chunk(8000));
      await stream.flush();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toMatch(/401/);
      expect(errors[0].message).toMatch(/key/i);
    });

    it(`${p.name}: reports a rate limit distinctly from an auth failure`, async () => {
      const errors: Error[] = [];
      restore();
      restore = stubFetch(async () => new Response("slow down", { status: 429 }));

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError((e) => errors.push(e));
      stream.write(chunk(8000));
      await stream.flush();

      expect(errors[0].message).toMatch(/429/);
      expect(errors[0].message).toMatch(/rate limited/i);
    });

    it(`${p.name}: emits the transcript on a successful turn`, async () => {
      const results: string[] = [];
      restore();
      restore = stubFetch(async () => Response.json(transcriptBody(p.name, "hello there")));

      const stream = p.make().createStream!();
      stream.onResult((r) => results.push(r.text));
      stream.onError(() => {});
      stream.write(chunk(8000));
      await stream.flush();

      expect(results).toEqual(["hello there"]);
    });

    it(`${p.name}: close() drains buffered audio and stays idempotent`, async () => {
      let called = 0;
      restore();
      restore = stubFetch(async () => {
        called++;
        return Response.json(transcriptBody(p.name, "tail"));
      });

      const stream = p.make().createStream!();
      stream.onResult(() => {});
      stream.onError(() => {});
      stream.write(chunk(8000));
      await stream.close();
      // A second close must not re-transcribe or throw.
      await expect(stream.close()).resolves.toBeUndefined();
      expect(called).toBe(1);
    });
  }
});

/** Provider-shaped JSON response for each batch STT provider. */
function transcriptBody(provider: string, text = "hello there") {
  switch (provider) {
    case "whisper":
      return { text };
    case "google":
      return { results: [{ alternatives: [{ transcript: text, confidence: 0.9 }] }] };
    case "azure":
      return { RecognitionStatus: "Success", DisplayText: text };
    default:
      return {};
  }
}

/** Minimal fake AssemblyAI socket, used to exercise the streaming lifecycle. */
class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = [];
  // The provider compares readyState against WebSocket.OPEN, so the constant
  // has to exist on the fake.
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  terminated = false;
  closed = false;

  constructor(public url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; this.emit("open"); }
  close(): void { this.closed = true; this.readyState = 3; this.emit("close"); }
  terminate(): void { this.terminated = true; this.readyState = 3; this.emit("close"); }
}

// The provider imports `ws` directly, so the module has to be mocked rather
// than the global.
vi.mock("ws", () => ({ WebSocket: FakeSocket }));

describe("AssemblyAI stream lifecycle", () => {
  beforeEach(() => { FakeSocket.instances = []; });

  async function makeStream(options?: { connectTimeoutMs?: number }) {
    const { AssemblyAISTT } = await import("../src/stt/assemblyai.js");
    // A short handshake deadline keeps the "never connects" cases fast; the
    // production default is 10s.
    const provider = new AssemblyAISTT({
      apiKey: "k",
      sampleRate: 16000,
      connectTimeoutMs: options?.connectTimeoutMs ?? 200,
    });
    return provider.createStream!();
  }

  it("close() terminates a socket that is still CONNECTING", async () => {
    const stream = await makeStream();
    // Never opened. The old teardown was gated on readyState === OPEN and
    // silently leaked the socket and its listeners.
    await stream.close();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].terminated).toBe(true);
  });

  it("sends a terminate message when the socket is open", async () => {
    const stream = await makeStream();
    FakeSocket.instances[0].open();
    await stream.close();
    expect(FakeSocket.instances[0].closed).toBe(true);
    expect(FakeSocket.instances[0].sent.join()).toContain("terminate_session");
  });

  it("buffers audio written before the socket opens and replays it", async () => {
    const stream = await makeStream();
    // Pre-connect audio used to be dropped entirely.
    stream.write(chunk(1000));
    stream.write(chunk(1000));
    expect(FakeSocket.instances[0].sent).toHaveLength(0);

    FakeSocket.instances[0].open();
    expect(FakeSocket.instances[0].sent.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the pre-connect buffer", async () => {
    const stream = await makeStream();
    for (let i = 0; i < 200; i++) stream.write(chunk(32 * 1024)); // ~6.5MB
    FakeSocket.instances[0].open();
    // Bounded to ~1s of audio, not everything that was written.
    expect(FakeSocket.instances[0].sent.length).toBeLessThan(5);
  });

  it("flush() waits for the handshake instead of returning an empty turn", async () => {
    const stream = await makeStream();
    let settled = false;
    const pending = stream.flush!().then(() => { settled = true; });

    // The socket has not opened yet; flush must not resolve immediately.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    FakeSocket.instances[0].open();
    await pending;
  });

  it("flush() resolves rather than rejecting when the socket errors first", async () => {
    const stream = await makeStream();
    const errors: Error[] = [];
    stream.onError?.((e) => errors.push(e));
    const pending = stream.flush!();
    FakeSocket.instances[0].emit("error", new Error("connect refused"));
    await expect(pending).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });

  it("releases a pending flush when the socket closes", async () => {
    const stream = await makeStream();
    FakeSocket.instances[0].open();
    const pending = stream.flush!();
    FakeSocket.instances[0].emit("close");
    await expect(pending).resolves.toBeUndefined();
  });

  it("is idempotent on close", async () => {
    const stream = await makeStream();
    FakeSocket.instances[0].open();
    await stream.close();
    await expect(stream.close()).resolves.toBeUndefined();
  });
});
