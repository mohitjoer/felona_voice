import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  McpClient,
  createMcpClient,
  collectMcpTools,
  extractMcpText,
  MCP_PROTOCOL_VERSION,
  type McpTransport,
} from "../src/tools/mcp.js";
import { ToolRegistry, createToolRegistry, defineTool } from "../src/tools/registry.js";

const SERVER = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.mjs", import.meta.url),
);

const open: McpClient[] = [];

function connect(flags: string[] = [], clientOptions = {}): McpClient {
  const client = createMcpClient({
    command: process.execPath,
    args: [SERVER, ...flags],
    requestTimeoutMs: 5_000,
    ...clientOptions,
  });
  open.push(client);
  return client;
}

/** An in-memory transport for the cases a subprocess cannot easily produce. */
function fakeTransport(): McpTransport & {
  sent: Array<{ id?: number; method?: string }>;
  respond: (id: number, result: unknown) => void;
  waitFor: (method: string) => Promise<{ id: number }>;
} {
  const handlers: Array<(m: never) => void> = [];
  const sent: Array<{ id?: number; method?: string }> = [];
  return {
    sent,
    start: async () => {},
    send: async (m) => {
      sent.push(m as { id?: number; method?: string });
    },
    onMessage: (h) => handlers.push(h as never),
    onClose: () => {},
    close: async () => {},
    respond: (id, result) =>
      handlers.forEach((h) => h({ jsonrpc: "2.0", id, result } as never)),
    // A response can only be correlated after its request has been sent, so
    // tests wait for the request rather than firing a reply optimistically.
    waitFor: (method) =>
      new Promise((resolve) => {
        const poll = () => {
          const found = sent.find((m) => m.method === method);
          if (found?.id !== undefined) {
            resolve({ id: found.id });
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      }),
  };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe("MCP client", () => {
  describe("handshake", () => {
    it("negotiates a protocol version and reports the server identity", async () => {
      const client = connect();
      const server = await client.connect();

      expect(server).toEqual({ name: "fake-mcp", version: "1.0.0" });
      expect(client.isConnected).toBe(true);
      // Connecting twice must not run a second handshake.
      expect(await client.connect()).toEqual(server);
    });

    it("sends initialized only after initialize resolves", async () => {
      const transport = fakeTransport();
      const client = new McpClient(transport);
      const connected = client.connect();

      const init = await transport.waitFor("initialize");
      transport.respond(init.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "s", version: "1" },
      });
      await connected;

      const methods = transport.sent.map((m) => m.method);
      expect(methods).toEqual(["initialize", "notifications/initialized"]);
    });

    it("shares one handshake between concurrent callers", async () => {
      const client = connect();
      const [a, b, c] = await Promise.all([
        client.connect(),
        client.connect(),
        client.connect(),
      ]);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
    });

    it("refuses a protocol version it does not support", async () => {
      const client = connect(["--bad-protocol"]);
      await expect(client.connect()).rejects.toThrow(
        /unsupported protocol version "1999-01-01"/,
      );
      expect(client.isConnected).toBe(false);
    });

    it("reports a server that dies during the handshake", async () => {
      const client = connect(["--exit-on-connect"]);
      await expect(client.connect()).rejects.toThrow(
        /fake-mcp-server\.mjs\) exited with code 3/,
      );
    });

    it("reports a command that cannot be spawned", async () => {
      const client = createMcpClient({
        command: "definitely-not-a-real-binary-xyz",
        requestTimeoutMs: 2_000,
      });
      open.push(client);
      await expect(client.connect()).rejects.toThrow(
        /MCP server process error .*ENOENT/,
      );
    });
  });

  describe("tools", () => {
    it("lists tools as AgentTool with schemas intact", async () => {
      const tools = await connect().list();

      expect(tools.map((t) => t.name)).toEqual(["get_weather", "add"]);

      const weather = tools[0];
      expect(weather.description).toBe("Returns the current weather as JSON");
      expect(weather.parameters).toMatchObject({
        type: "object",
        required: ["city"],
      });
      expect(typeof weather.execute).toBe("function");
    });

    it("calls a tool and returns the server's content blocks", async () => {
      const result = (await connect().call("get_weather", {
        city: "Leeds",
      })) as { content: Array<{ type: string; text?: string }> };

      expect(result.content[0].text).toBe("It is 21C and raining in Leeds.");
    });

    it("returns only text via callText, keeping non-text blocks", async () => {
      const text = await connect().callText("add", { a: 2, b: 40 });
      // The image block is stringified rather than dropped.
      expect(text).toContain("42");
      expect(text).toContain("image/png");
    });

    it("executes a bridged tool through the registry", async () => {
      const registry = createToolRegistry([
        defineTool({
          name: "native_tool",
          description: "a native tool",
          parameters: { type: "object", properties: {} },
          execute: async () => "native result",
        }),
      ]);

      const tools = await connect().registerInto(registry);

      expect(tools).toHaveLength(2);
      expect(registry.list().map((t) => t.name)).toEqual([
        "native_tool",
        "get_weather",
        "add",
      ]);
      expect(
        await registry.call("get_weather", { city: "Oslo" }),
      ).toMatchObject({ content: [{ text: "It is 21C and raining in Oslo." }] });
    });

    it("surfaces isError as a thrown error, not a spoken result", async () => {
      const client = connect(["--tool-error"]);
      await expect(client.call("get_weather", { city: "X" })).rejects.toThrow(
        /upstream refused the lookup/,
      );
    });

    it("surfaces a JSON-RPC error response", async () => {
      const client = connect(["--rpc-error"]);
      await expect(client.call("get_weather", { city: "X" })).rejects.toThrow(
        /Invalid tool arguments/,
      );
    });

    it("rejects an unsafe tool name instead of exposing it", async () => {
      await expect(connect(["--bad-tool-name"]).list()).rejects.toThrow(
        /Invalid tool name/,
      );
    });

    it("rejects a tools/list with no tool array", async () => {
      await expect(connect(["--no-tools"]).list()).rejects.toThrow(
        /returned no tool array/,
      );
    });
  });

  describe("name prefix", () => {
    it("namespaces tools and strips the prefix when calling", async () => {
      const client = connect([], { namePrefix: "wx_" });
      const tools = await client.list();

      expect(tools.map((t) => t.name)).toEqual(["wx_get_weather", "wx_add"]);
      expect(await client.listToolNames()).toEqual(["wx_get_weather", "wx_add"]);

      const result = (await client.call("wx_get_weather", {
        city: "Kyoto",
      })) as { content: Array<{ text?: string }> };
      // The server received "get_weather", not "wx_get_weather".
      expect(result.content[0].text).toContain("Kyoto");
    });

    it("rejects a prefix that would produce an invalid name", () => {
      expect(() => connect([], { namePrefix: "bad prefix!" })).toThrow(
        /Invalid MCP namePrefix/,
      );
    });

    it("detects collisions when bridging several servers", async () => {
      const a = connect();
      const b = connect();
      await expect(collectMcpTools([a, b])).rejects.toThrow(
        /Duplicate MCP tool name "get_weather"/,
      );
    });

    it("collects tools from multiple servers with distinct prefixes", async () => {
      const a = connect([], { namePrefix: "a_" });
      const b = connect([], { namePrefix: "b_" });
      const tools = await collectMcpTools([a, b]);
      expect(tools.map((t) => t.name)).toEqual([
        "a_get_weather",
        "a_add",
        "b_get_weather",
        "b_add",
      ]);
    });
  });

  describe("resilience", () => {
    it("times out a call the server never answers", async () => {
      const client = connect(["--hang", "tools/call"], {
        requestTimeoutMs: 300,
      });
      await expect(client.call("add", { a: 1, b: 1 })).rejects.toThrow(
        /timed out after 300ms/,
      );
    });

    it("skips a non-JSON line instead of dropping the connection", async () => {
      const client = connect(["--garbage"]);
      // The garbage line precedes the handshake response; the call still works.
      expect(await client.callText("add", { a: 1, b: 2 })).toContain("3");
    });

    it("fails in-flight calls when the connection drops", async () => {
      const transport = fakeTransport();
      const client = new McpClient(transport, { requestTimeoutMs: 10_000 });

      const listing = client.list();
      const init = await transport.waitFor("initialize");
      transport.respond(init.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "s", version: "1" },
      });

      // tools/list is now outstanding; drop the connection under it.
      await transport.waitFor("tools/list");
      await client.close();

      await expect(listing).rejects.toThrow(/closed/i);
    });

    it("refuses to send after close", async () => {
      const client = connect();
      await client.connect();
      await client.close();
      await expect(client.call("add", { a: 1, b: 1 })).rejects.toThrow(
        /client is closed/,
      );
    });
  });

  describe("describeTool", () => {
    it("rewrites the description handed to the LLM", async () => {
      const client = connect([], {
        describeTool: (tool, fullName) =>
          `Look up the ${tool.name} for a caller. (${fullName})`,
      });
      const tools = await client.list();
      expect(tools[0].description).toBe(
        "Look up the get_weather for a caller. (get_weather)",
      );
    });
  });
});

describe("extractMcpText", () => {
  it("joins text blocks and stringifies anything else", () => {
    const text = extractMcpText({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "image", data: "x" },
      ],
    });
    expect(text).toBe("first\nsecond\n" + JSON.stringify({ type: "image", data: "x" }));
  });

  it("returns an empty string for a malformed result", () => {
    expect(extractMcpText(undefined as never)).toBe("");
    expect(extractMcpText({ content: undefined } as never)).toBe("");
  });
});

describe("registry interop", () => {
  it("keeps MCP tools callable through ToolRegistry.call", async () => {
    const registry = new ToolRegistry();
    const client = connect();
    const bridged = await client.list();
    registry.registerAll(bridged);

    expect(registry.has("add")).toBe(true);
    expect(registry.getSchema("add")).toMatchObject({
      name: "add",
      parameters: { type: "object" },
    });
    await expect(registry.call("nope")).rejects.toThrow(/not found/);
  });
});

describe("builder integration", () => {
  it("registers native tools through the builder", async () => {
    const { createAgent } = await import("../src/builder.js");
    const agent = createAgent("Support")
      .tool(
        defineTool({
          name: "lookup_order",
          description: "Look up an order",
          parameters: { type: "object", properties: { id: { type: "string" } } },
          execute: async () => "shipped",
        }),
      )
      .build();

    expect(agent.toolRegistry.has("lookup_order")).toBe(true);
    expect(agent.toolRegistry.getAllSchemas()).toHaveLength(1);
  });

  it("rejects a duplicate native tool name", async () => {
    const { createAgent } = await import("../src/builder.js");
    const t = defineTool({
      name: "dup",
      description: "d",
      parameters: { type: "object" },
      execute: async () => "x",
    });
    expect(() => createAgent("A").tool(t).tool(t)).toThrow(/already registered/);
  });

  it("invalidates the build cache when a tool is added", async () => {
    const { createAgent } = await import("../src/builder.js");
    const builder = createAgent("Support");
    const first = builder.build();
    expect(first.toolRegistry.list()).toHaveLength(0);

    const second = builder
      .tool(
        defineTool({
          name: "later",
          description: "added after build",
          parameters: { type: "object" },
          execute: async () => "x",
        }),
      )
      .build();

    // A stale cache would hand back the agent built before the tool existed.
    expect(second).not.toBe(first);
    expect(second.toolRegistry.has("later")).toBe(true);
  });

  it("adds MCP server tools via connectMcp()", async () => {
    const { createAgent } = await import("../src/builder.js");
    const client = connect();
    const agent = await createAgent("Support").mcp(client).connectMcp();

    expect(agent.toolRegistry.has("get_weather")).toBe(true);
    expect(agent.toolRegistry.has("add")).toBe(true);
    expect(
      await agent.toolRegistry.call("get_weather", { city: "Cork" }),
    ).toMatchObject({ content: [{ text: expect.stringContaining("Cork") }] });
  });

  it("fails loudly when an MCP server cannot be reached", async () => {
    const { createAgent } = await import("../src/builder.js");
    const client = createMcpClient({
      command: "definitely-not-a-real-binary-xyz",
      requestTimeoutMs: 2_000,
    });
    open.push(client);

    // Silently returning a tool-less agent would only fail mid-call.
    await expect(
      createAgent("Support").mcp(client).connectMcp(),
    ).rejects.toThrow();
  });

  it("rejects registering the same client twice", async () => {
    const { createAgent } = await import("../src/builder.js");
    const client = connect();
    expect(() => createAgent("A").mcp(client).mcp(client)).toThrow(
      /already registered/,
    );
  });
});

describe("MCP transport restart", () => {
  it("respawns a server that died instead of throwing 'already started'", async () => {
    const { StdioMcpTransport } = await import("../src/tools/mcp.js");
    const transport = new StdioMcpTransport({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},50)"],
    });
    await transport.start();
    // A dead child is still set, so a second start() is the restart path.
    await expect(transport.start()).resolves.toBeUndefined();
    await transport.close();
  });

  it("close() is still idempotent and final", async () => {
    const { StdioMcpTransport } = await import("../src/tools/mcp.js");
    const transport = new StdioMcpTransport({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},50)"],
    });
    await transport.start();
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
