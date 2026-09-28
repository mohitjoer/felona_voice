import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { emitSafe } from "../src/events/emit.js";
import { WebSocketTransport } from "../src/transport/websocket.js";
import { CallSupervisor } from "../src/supervision/controller.js";
import type { Session, Transport } from "../src/types.js";

// `vi.mock` factories are hoisted above imports, so the shared registry has to
// be created with `vi.hoisted` for the factory to be able to reach it.
const { registry } = vi.hoisted(() => ({ registry: { instances: [] as any[] } }));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWs extends EventEmitter {
    readyState = 1;
    sent: unknown[] = [];
    closed = false;
    closeCode?: number;
    terminateCalled = false;
    constructor(public url?: string) {
      super();
      registry.instances.push(this);
    }
    send(data: unknown): void { this.sent.push(data); }
    close(code?: number): void {
      this.closed = true;
      this.closeCode = code;
      this.readyState = 3;
      this.emit("close", code);
    }
    terminate(): void {
      this.terminateCalled = true;
      this.readyState = 3;
      this.emit("close");
    }
    ping(): void {}
  }

  class WebSocketServer extends EventEmitter {
    clients = new Set();
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown> = {}) {
      super();
      this.options = opts;
      // The real server emits this once bound; `start()` awaits it.
      setImmediate(() => this.emit("listening"));
    }
    close(cb?: () => void): void { cb?.(); }
    handleUpgrade(): void {}
  }

  return { WebSocket: FakeWs, WebSocketServer, default: FakeWs, OPEN: 1 };
});

function makeSession(id = "s1"): Session {
  return { id, startedAt: new Date(), metadata: {}, state: "active" };
}

describe("WebSocketTransport lifecycle", () => {
  beforeEach(() => { registry.instances.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); });

  async function connectedTransport() {
    const transport = new WebSocketTransport({ port: 0, path: "/stream" });
    await transport.start({ port: 0 });
    // The transport never constructs a socket itself — the server does — so
    // the test provides one and registers it in the shared registry.
    const { WebSocket } = (await import("ws")) as unknown as {
      WebSocket: new (url?: string) => any;
    };
    const ws = new WebSocket();
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    // @ts-expect-error - driving the private path directly
    transport.handleConnection(ws, req);
    const sessions = (transport as unknown as { sessions: Map<string, { session: Session }> }).sessions;
    const sessionId = [...sessions.keys()][0];
    return { transport, session: sessions.get(sessionId)!.session, ws };
  }

  it("fires disconnect exactly once when the socket closes", async () => {
    const { transport, ws } = await connectedTransport();
    const disconnects: Session[] = [];
    transport.onDisconnect((s) => disconnects.push(s));
    ws.close();
    expect(disconnects).toHaveLength(1);
    await transport.stop();
  });

  it("closeSession tears down one call and reports it once", async () => {
    const { transport, session, ws } = await connectedTransport();
    const disconnects: Session[] = [];
    transport.onDisconnect((s) => disconnects.push(s));
    await transport.closeSession(session.id);
    expect(disconnects).toHaveLength(1);
    expect(ws.closed).toBe(true);
    // The socket's own close handler must not double-report.
    ws.emit("close");
    expect(disconnects).toHaveLength(1);
    await transport.stop();
  });

  it("stop() does not double-report for a socket already closed", async () => {
    const { transport, ws } = await connectedTransport();
    const disconnects: Session[] = [];
    transport.onDisconnect((s) => disconnects.push(s));
    // Socket closes first, then shutdown runs.
    ws.close();
    await transport.stop();
    expect(disconnects).toHaveLength(1);
  });

  it("closeSession on an unknown id is a no-op", async () => {
    const { transport } = await connectedTransport();
    const disconnects: Session[] = [];
    transport.onDisconnect((s) => disconnects.push(s));
    await expect(transport.closeSession("nope")).resolves.toBeUndefined();
    expect(disconnects).toHaveLength(0);
    await transport.stop();
  });

  it("refuses to overwrite protected metadata from a client", async () => {
    const { transport, session } = await connectedTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // @ts-expect-error - private
    transport.applyMetadataPatch(session, {
      from: "+15550000000",
      callSid: "CA-evil",
      orderId: "A-1",
    });
    expect(session.metadata.orderId).toBe("A-1");
    expect(session.metadata.from).toBeUndefined();
    expect(session.metadata.callSid).toBeUndefined();
    warn.mockRestore();
    await transport.stop();
  });

  it("drops prototype-polluting keys", async () => {
    const { transport, session } = await connectedTransport();
    // @ts-expect-error - private
    transport.applyMetadataPatch(session, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await transport.stop();
  });
});

describe("CallSupervisor.disconnect", () => {
  function stubTransport(overrides: Partial<Transport> = {}) {
    const counters = { stops: 0, closes: [] as string[] };
    const transport = {
      start: async () => {},
      stop: async () => { counters.stops++; },
      closeSession: async (id: string) => { counters.closes.push(id); },
      onAudioChunk: () => {},
      onConnect: () => {},
      onDisconnect: () => {},
      sendAudio: async () => {},
      ...overrides,
    } as unknown as Transport;
    return { transport, counters };
  }

  it("closes only its own session, not the whole transport", async () => {
    const { transport, counters } = stubTransport();
    const session = makeSession("call-A");
    const supervisor = new CallSupervisor("call-A", {
      transport,
      resolveSession: (id) => (id === "call-A" ? session : undefined),
    });

    await supervisor.disconnect();

    // The bug: this used to call transport.stop(), dropping every other call.
    expect(counters.stops).toBe(0);
    expect(counters.closes).toEqual(["call-A"]);
  });

  it("falls back to stop() for transports without closeSession", async () => {
    const { transport, counters } = stubTransport();
    const bare = { ...transport, closeSession: undefined } as unknown as Transport;
    const supervisor = new CallSupervisor("call-B", {
      transport: bare,
      resolveSession: () => makeSession("call-B"),
    });
    await supervisor.disconnect();
    expect(counters.stops).toBe(1);
  });

  it("does nothing when the session is already gone", async () => {
    const { transport, counters } = stubTransport();
    const supervisor = new CallSupervisor("gone", {
      transport,
      resolveSession: () => undefined,
    });
    await supervisor.disconnect();
    expect(counters.stops).toBe(0);
    expect(counters.closes).toHaveLength(0);
  });

  it("swallows a teardown error", async () => {
    const { transport } = stubTransport({
      closeSession: async () => { throw new Error("already closed"); },
    });
    const supervisor = new CallSupervisor("call-C", {
      transport,
      resolveSession: () => makeSession("call-C"),
    });
    await expect(supervisor.disconnect()).resolves.toBeUndefined();
  });
});
