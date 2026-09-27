/**
 * A minimal MCP server used by the client tests.
 *
 * It is a real subprocess speaking newline-delimited JSON-RPC on stdio, so the
 * transport is exercised end to end rather than mocked. Behaviour is driven by
 * argv so one script can play both the healthy server and the broken ones:
 *
 *   node fake-mcp-server.js                      healthy server
 *   node fake-mcp-server.js --bad-protocol       answers with an unknown revision
 *   node fake-mcp-server.js --tool-error         tools/call returns isError
 *   node fake-mcp-server.js --rpc-error          tools/call returns a JSON-RPC error
 *   node fake-mcp-server.js --hang tools/call    never answers (timeout tests)
 *   node fake-mcp-server.js --exit-on-connect    dies during the handshake
 *   node fake-mcp-server.js --garbage            writes a non-JSON line first
 *   node fake-mcp-server.js --no-tools           tools/list without a tool array
 *   node fake-mcp-server.js --bad-tool-name      advertises an unsafe tool name
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const PROTOCOL = flag("--bad-protocol") ? "1999-01-01" : "2025-06-18";

const TOOLS = [
  {
    name: "get_weather",
    description: "Returns the current weather as JSON",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "add",
    description: "Adds two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolsListResult() {
  if (flag("--no-tools")) return { notTools: [] };
  if (flag("--bad-tool-name")) {
    return { tools: [{ name: "bad name; rm -rf /", description: "nope" }] };
  }
  return { tools: TOOLS };
}

function callResult(id, params) {
  const args = params?.arguments ?? {};

  if (flag("--tool-error")) {
    return {
      content: [{ type: "text", text: "upstream refused the lookup" }],
      isError: true,
    };
  }
  if (flag("--rpc-error")) {
    replyError(id, -32602, "Invalid tool arguments");
    return;
  }

  if (args.city) {
    return {
      content: [{ type: "text", text: `It is 21C and raining in ${args.city}.` }],
    };
  }

  const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
  return {
    content: [
      { type: "text", text: String(sum) },
      // A non-text block: the client must not drop it silently.
      { type: "image", data: "ignored", mimeType: "image/png" },
    ],
  };
}

// A stray line before the handshake proves the client skips unparseable output
// instead of tearing the connection down.
if (flag("--garbage")) {
  process.stdout.write("server starting up, not json yet\n");
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = message;

  // No id means a notification, which takes no reply.
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      if (flag("--exit-on-connect")) process.exit(3);
      reply(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
      return;

    case "tools/list":
      reply(id, toolsListResult());
      return;

    case "tools/call":
      if (valueOf("--hang") === "tools/call") return; // never answer
      reply(id, callResult(id, params));
      return;

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
});
