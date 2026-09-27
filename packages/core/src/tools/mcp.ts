/**
 * MCP (Model Context Protocol) client.
 *
 * Lets a voice agent borrow tools from any MCP server and use them exactly like
 * native ones. The whole surface is two JSON-RPC calls — `tools/list` and
 * `tools/call` — so this is deliberately dependency-free rather than pulling in
 * an SDK: the protocol is small, and a framework that lets you self-host should
 * not force a transport stack on you.
 *
 * `McpClient` implements `ToolExecutor`, so it can stand in anywhere the agent
 * expects tools, and `asTools()` bridges a server's tools into a `ToolRegistry`
 * when you want them mixed with native ones.
 *
 * Two rules shaped the error handling here. A call is a real-time interaction,
 * so a wedged server must surface as a timeout rather than hang the call. And
 * every request owns a pending promise, so `close()` has to settle all of them —
 * an unsettled promise is an unhandled rejection waiting for the next tick.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentTool } from "../types.js";

// ─── Protocol types ─────────────────────────────────────────────────────────

/** Latest protocol revision this client offers during negotiation. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Revisions accepted if a server answers with an older one. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  id: JsonRpcId;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** A tool as an MCP server advertises it. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** The result of `tools/call`, kept in the server's own shape. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

// ─── Transport ──────────────────────────────────────────────────────────────

/**
 * The byte-moving half of a client. Split out so an in-process server, a socket,
 * or a test double can stand in for spawning a child process.
 */
export interface McpTransport {
  /** Begin receiving messages. */
  start(): Promise<void>;
  /** Deliver one message to the server. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Called for every inbound message, including notifications. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Called once when the connection ends, for any reason. */
  onClose(handler: (reason: string) => void): void;
  /** Tear down the connection. Must be safe to call more than once. */
  close(): Promise<void>;
}

export interface McpStdioTransportOptions {
  /** Executable to spawn, e.g. `npx` or `uvx`. */
  command: string;
  /** Arguments, usually the server package spec. */
  args?: string[];
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Extra environment for the child. Inherited variables are passed through;
   * this is merged on top, which is how a server's API key gets to it.
   */
  env?: Record<string, string>;
  /**
   * What to do with the server's stderr. Default: `forward`.
   *
   * - `forward` — log each line prefixed with the server name.
   * - `inherit` — write it straight to this process's stderr.
   * - `ignore` — discard it.
   *
   * The stream is piped and drained in every case. Leaving it unread would let
   * the child block once the OS pipe buffer fills, which shows up as a server
   * that mysteriously stops answering.
   */
  stderr?: "forward" | "inherit" | "ignore";
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface McpClientOptions {
  /** Name reported to the server during the handshake. Default: `felona-voice`. */
  clientName?: string;
  /** Version reported during the handshake. */
  clientVersion?: string;
  /**
   * Protocol revision to request. Default: {@link MCP_PROTOCOL_VERSION}.
   * A server answering with a revision it supports is always accepted.
   */
  protocolVersion?: string;
  /**
   * Milliseconds to wait for any single response before failing the call.
   * Default: 30000. Set to 0 to disable, though a hung server then hangs the call.
   */
  requestTimeoutMs?: number;
  /**
   * Prefix applied to every tool name this client exposes, e.g. `"weather_"`
   * or `"weather."`. Needed when more than one server is bridged into a single
   * registry and two servers happen to ship a `search` tool.
   */
  namePrefix?: string;
  /**
   * Rewrite the description sent to the LLM. MCP descriptions are often written
   * for a text model ("Returns the current weather as JSON") and read badly when
   * spoken, so this is the hook for making them voice-shaped.
   */
  describeTool?: (tool: McpToolDescriptor, fullName: string) => string;
}

// ─── Validation helpers ─────────────────────────────────────────────────────

/** Tool names reach the LLM and the registry, so a hostile name must not. */
const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function assertValidToolName(name: string, context: string): void {
  if (!VALID_TOOL_NAME.test(name)) {
    throw new Error(
      `Invalid tool name ${JSON.stringify(name)} from ${context}. ` +
        `Names must be 1-128 characters of [A-Za-z0-9_.-].`,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Pull readable text out of a tool result.
 *
 * MCP content blocks are typed, but a voice agent can only speak text, so this
 * keeps the text blocks and JSON-stringifies anything else rather than dropping
 * it. A tool that returns a number should not return silence.
 */
export function extractMcpText(result: McpToolResult): string {
  if (!result || !Array.isArray(result.content)) return "";

  const parts: string[] = [];
  for (const block of result.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" && block.resource) {
      const res = block.resource as { text?: unknown; uri?: unknown };
      if (typeof res.text === "string") parts.push(res.text);
      else if (res.uri) parts.push(String(res.uri));
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

// ─── Stdio transport ────────────────────────────────────────────────────────

/**
 * Newline-delimited JSON-RPC over a child process's stdin/stdout. This is the
 * transport MCP servers are launched with locally.
 */
export class StdioMcpTransport implements McpTransport {
  /**
   * A server that never emits a newline would otherwise grow this buffer
   * without bound. Real responses are far below the cap.
   */
  private static readonly MAX_LINE_BYTES = 8 * 1024 * 1024;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private messageHandler: ((message: JsonRpcMessage) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private closed = false;

  constructor(private readonly options: McpStdioTransportOptions) {}

  /**
   * How to name this server in an error. Absolute paths are shortened to their
   * basename: the runtime and the script are what identify the server, and a
   * truncated absolute path loses exactly the part that says which one.
   */
  private describeServer(): string {
    const base = (value: string) => value.split(/[\\/]/).pop() || value;
    const first = this.options.args?.[0];
    return first
      ? `${base(this.options.command)} ${base(first)}`
      : base(this.options.command);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("MCP stdio transport already started");
    if (!this.options.command) {
      throw new Error("MCP stdio transport requires a `command` to spawn");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio,
      });
      this.child = child;

      // A spawn failure (ENOENT, EACCES) arrives as an 'error' event, not a throw.
      child.on("error", (err) => {
        if (settled) {
          this.closeHandler?.(
            `MCP server process error (${this.describeServer()}): ${err.message}`,
          );
          return;
        }
        settled = true;
        reject(
          new Error(
            `Failed to start MCP server "${this.describeServer()}": ${err.message}`,
          ),
        );
      });

      child.stdout.on("data", (data: Buffer) => this.onData(data));

      // Always drained — see McpStdioTransportOptions.stderr.
      child.stderr.on("data", (data: Buffer) => {
        const mode = this.options.stderr ?? "forward";
        if (mode === "ignore") return;
        if (mode === "inherit") {
          process.stderr.write(data);
          return;
        }
        const text = data.toString("utf8").trim();
        if (text) console.error(`[MCP] ${this.describeServer()}: ${text}`);
      });

      child.on("close", (code, signal) => {
        const reason =
          signal !== null
            ? `terminated by signal ${signal}`
            : `exited with code ${code}`;
        if (!settled) {
          settled = true;
          reject(
            new Error(`MCP server (${this.describeServer()}) ${reason} during startup`),
          );
          return;
        }
        this.closeHandler?.(
          `MCP server (${this.describeServer()}) ${reason}`,
        );
      });

      settled = true;
      resolve();
    });
  }

  private onData(data: Buffer): void {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);

    if (this.buffer.length > StdioMcpTransport.MAX_LINE_BYTES) {
      this.closeHandler?.(
        `server sent ${this.buffer.length} bytes without a newline`,
      );
      void this.close();
      return;
    }

    let newlineIndex = this.buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line) this.parseLine(line);
      newlineIndex = this.buffer.indexOf(0x0a);
    }
  }

  private parseLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // A server logging to stdout corrupts the stream. Dropping the line is
      // better than tearing down a working call, and the missing response will
      // surface as a timeout on the request that is waiting for it.
      console.warn(`[MCP] Ignoring non-JSON line on stdout: ${line.slice(0, 200)}`);
      return;
    }
    this.messageHandler?.(message);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || !this.child || this.child.killed) {
      throw new Error("MCP stdio transport is closed");
    }
    // The newline is part of the framing: a server reading line-delimited JSON
    // will not emit an unterminated line, so omitting it silently hangs.
    const payload = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          reject(new Error(`Failed to write to MCP server: ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      // SIGTERM first so the server can flush and exit on its own; the timer is
      // the backstop for a server that ignores it.
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      killTimer.unref?.();

      child.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}

export function createStdioMcpTransport(
  options: McpStdioTransportOptions,
): StdioMcpTransport {
  return new StdioMcpTransport(options);
}

// ─── Client ─────────────────────────────────────────────────────────────────

interface ServerIdentity {
  name: string;
  version: string;
}

/**
 * McpClient — a connected MCP server exposed as a set of agent tools.
 *
 * The connection is lazy: the handshake happens on the first `connect()` (or the
 * first tool call, which connects on demand), so constructing a client for a
 * server that is not running costs nothing.
 *
 * Deliberately not a `ToolExecutor`. That interface lists tools synchronously,
 * and an MCP server is a subprocess that has to be asked over a pipe — a client
 * that pretended otherwise would either block the event loop or lie about what
 * it knows. Bridge a server in with {@link McpClient.registerInto} or
 * {@link McpClient.asTools} and the resulting `AgentTool`s are ordinary
 * synchronous tools.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly protocolVersion: string;
  private readonly namePrefix: string;

  private messageHandler: ((message: JsonRpcMessage) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private nextId = 1;
  private connected = false;
  private connecting: Promise<ServerIdentity> | null = null;
  private serverInfo: ServerIdentity | null = null;
  private negotiatedVersion: string | null = null;
  private closed = false;

  constructor(
    transport: McpTransport,
    private readonly options: McpClientOptions = {},
  ) {
    this.transport = transport;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;

    const prefix = options.namePrefix ?? "";
    if (prefix && !VALID_TOOL_NAME.test(prefix)) {
      throw new Error(
        `Invalid MCP namePrefix ${JSON.stringify(prefix)}. ` +
          `Use 1-128 characters of [A-Za-z0-9_.-].`,
      );
    }
    this.namePrefix = prefix;
  }

  /** Whether the handshake has completed. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Name and version the server reported, once connected. */
  get server(): ServerIdentity | null {
    return this.serverInfo;
  }

  /**
   * Start the transport and perform the MCP handshake. Safe to call repeatedly:
   * concurrent callers share one attempt, so two tools firing at once cannot
   * produce two `initialize` exchanges.
   */
  async connect(): Promise<ServerIdentity> {
    if (this.closed) throw new Error("MCP client is closed");
    if (this.connected && this.serverInfo) return this.serverInfo;
    if (this.connecting) return this.connecting;

    this.connecting = this.performHandshake().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async performHandshake(): Promise<ServerIdentity> {
    this.transport.onMessage((message) => this.onMessage(message));
    this.transport.onClose((reason) => this.onClose(reason));
    await this.transport.start();

    const result = (await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? "felona-voice",
        version: this.options.clientVersion ?? "0.0.0",
      },
    })) as {
      protocolVersion?: unknown;
      serverInfo?: { name?: unknown; version?: unknown };
    };

    // A server that answers with a revision we do not know is a real
    // compatibility problem, not something to paper over.
    const serverVersion =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
    if (serverVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(serverVersion)) {
      await this.close();
      throw new Error(
        `MCP server negotiated unsupported protocol version "${serverVersion}". ` +
          `This client supports: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(", ")}.`,
      );
    }
    this.negotiatedVersion = serverVersion || this.protocolVersion;

    const info = result?.serverInfo;
    this.serverInfo = {
      name: typeof info?.name === "string" ? info.name : "unknown",
      version: typeof info?.version === "string" ? info.version : "unknown",
    };

    // The server only starts serving requests after this notification, so it
    // is fire-and-forget by design — a failure here is logged, not thrown,
    // because the connection is already usable.
    try {
      await this.transport.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
    } catch (error) {
      console.warn(
        `[MCP] Could not send initialized notification: ${describeError(error)}`,
      );
    }

    this.connected = true;
    return this.serverInfo;
  }

  /**
   * List the server's tools as `AgentTool`s.
   *
   * `inputSchema` is passed through untouched, so whatever JSON Schema the
   * server publishes reaches the LLM exactly as written.
   */
  async list(): Promise<AgentTool[]> {
    await this.connect();
    const result = (await this.request("tools/list", {})) as {
      tools?: unknown;
    };

    if (!Array.isArray(result?.tools)) {
      throw new Error(
        `MCP tools/list returned no tool array (got ${typeof result?.tools})`,
      );
    }

    return result.tools.map((entry) => this.toAgentTool(entry, "tools/list"));
  }

  /** Names of the server's tools, without the handshake cost of `list()`. */
  async listToolNames(): Promise<string[]> {
    await this.connect();
    const result = (await this.request("tools/list", {})) as { tools?: unknown };
    if (!Array.isArray(result?.tools)) {
      throw new Error("MCP tools/list returned no tool array");
    }
    return result.tools.map((entry) => {
      const tool = this.toDescriptor(entry, "tools/list");
      return `${this.namePrefix}${tool.name}`;
    });
  }

  /**
   * Call a tool on the server.
   *
   * The server's result is returned in its own `content` shape rather than
   * flattened, because a caller may want more than text. Use
   * {@link extractMcpText} to get the speakable part. A tool that reports
   * `isError` throws, so a failure is never mistaken for a result the agent
   * reads aloud.
   */
  async call(
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.connect();

    // Strip our own prefix so the server sees the name it published.
    const name = this.namePrefix && toolName.startsWith(this.namePrefix)
      ? toolName.slice(this.namePrefix.length)
      : toolName;

    const result = await this.request("tools/call", {
      name,
      arguments: params ?? {},
    });

    const payload = result as McpToolResult;
    if (payload && typeof payload === "object" && payload.isError === true) {
      throw new Error(
        `MCP tool "${toolName}" failed: ${extractMcpText(payload) || "no detail"}`,
      );
    }
    return result;
  }

  /**
   * Call a tool and return only its text, which is what a voice agent wants to
   * speak. Throws if the server flags the result as an error.
   */
  async callText(
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.call(toolName, params)) as McpToolResult;
    return extractMcpText(result);
  }

  /**
   * Bridge this server's tools into a `ToolRegistry`, so MCP tools and native
   * ones are callable by the same name.
   */
  async registerInto(registry: {
    registerAll(tools: AgentTool[]): void;
  }): Promise<AgentTool[]> {
    const tools = await this.asTools();
    registry.registerAll(tools);
    return tools;
  }

  /**
   * This server's tools as `AgentTool`s, without registering them anywhere.
   * Use this when you want to filter or combine servers before wiring them up.
   */
  async asTools(): Promise<AgentTool[]> {
    return this.list();
  }

  /** Close the connection and fail anything still in flight. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.failPending("MCP client closed");
    await this.transport.close();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private toDescriptor(entry: unknown, context: string): McpToolDescriptor {
    if (!entry || typeof entry !== "object") {
      throw new Error(`MCP ${context} returned a non-object tool entry`);
    }
    const raw = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new Error(`MCP ${context} returned a tool without a name`);
    }
    assertValidToolName(raw.name, context);

    return {
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      inputSchema:
        raw.inputSchema && typeof raw.inputSchema === "object"
          ? (raw.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    };
  }

  private toAgentTool(entry: unknown, context: string): AgentTool {
    const descriptor = this.toDescriptor(entry, context);
    const fullName = `${this.namePrefix}${descriptor.name}`;
    assertValidToolName(fullName, context);

    const described =
      this.options.describeTool?.(descriptor, fullName) ?? descriptor.description;

    return {
      name: fullName,
      description: described ?? `MCP tool "${descriptor.name}"`,
      parameters: descriptor.inputSchema ?? { type: "object", properties: {} },
      execute: async (params: Record<string, unknown>) => this.call(fullName, params),
    };
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP client is closed; cannot call ${method}`));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.settleRequest(
                id,
                new Error(
                  `MCP request "${method}" timed out after ${this.timeoutMs}ms`,
                ),
              );
            }, this.timeoutMs)
          : (null as unknown as NodeJS.Timeout);
      timer?.unref?.();

      this.pending.set(id, { id, resolve, reject, timer, method });

      this.transport
        .send({ jsonrpc: "2.0", id, method, params })
        .catch((err: unknown) => {
          this.settleRequest(
            id,
            new Error(
              `Failed to send MCP request "${method}": ${describeError(err)}`,
            ),
          );
        });
    });
  }

  /**
   * The single place a pending request is completed.
   *
   * Every completion path goes through here — response, protocol error,
   * timeout, send failure, and teardown — so a request can only ever be
   * settled once, and its timer is always cleared with it.
   */
  private settleRequest(id: JsonRpcId, error?: Error, value?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private onMessage(message: JsonRpcMessage): void {
    this.messageHandler?.(message);

    // Notifications and server-initiated requests carry no id we are waiting on.
    if (message.id === undefined) return;

    const entry = this.pending.get(message.id);
    if (!entry) return;

    if (message.error) {
      this.settleRequest(
        message.id,
        new Error(
          `MCP ${entry.method} failed (code ${message.error.code}): ${message.error.message}`,
        ),
      );
      return;
    }
    this.settleRequest(message.id, undefined, message.result);
  }

  /**
   * The connection ended. Anything still in flight can never be answered, so it
   * is failed here rather than left to sit until its timeout.
   */
  private onClose(reason: string): void {
    this.connected = false;
    this.failPending(`MCP connection closed: ${reason}`);
  }

  private failPending(reason: string): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.settleRequest(
        entry.id,
        new Error(`${reason} (while awaiting ${entry.method})`),
      );
    }
  }
}

export interface McpServerOptions extends McpClientOptions {
  /** Command to spawn, e.g. `npx`. */
  command: string;
  /** Arguments, usually the server package spec. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: "forward" | "inherit" | "ignore";
}

/**
 * Convenience factory: a client already wired to a spawned stdio server.
 */
export function createMcpClient(
  options: McpServerOptions,
): McpClient {
  const { command, args, cwd, env, stderr, ...clientOptions } = options;
  const transport = new StdioMcpTransport({ command, args, cwd, env, stderr });
  return new McpClient(transport, clientOptions);
}

/** Collect several MCP servers into one flat, collision-checked tool list. */
export async function collectMcpTools(
  clients: McpClient[],
): Promise<AgentTool[]> {
  const lists = await Promise.all(clients.map((client) => client.list()));
  const tools = lists.flat();
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate MCP tool name "${tool.name}". ` +
          `Give each server a distinct namePrefix when bridging more than one.`,
      );
    }
    seen.add(tool.name);
  }
  return tools;
}
