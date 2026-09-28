/**
 * First-class LLM providers.
 *
 * The framework routes turns with JEV and executes actions in user code, so
 * before this a conversational agent meant hand-rolling a client in every
 * handler. That left streaming, tool-calling loops, token accounting and
 * cancellation to be reimplemented per project.
 *
 * An `LLMProvider` is a small interface on purpose. The interesting work is in
 * `chat()`: it streams, drives the tool loop, and — the part that matters for
 * voice — stops as soon as the caller interrupts.
 */

import { fetchWithTimeout, isAbortError } from "../resilience/timeout.js";
import { retry } from "../resilience/retry.js";
import type { AgentTool, ConversationTurn } from "../types.js";

/** One message in the LLM conversation. */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call this message is responding to, for `role: "tool"`. */
  toolCallId?: string;
  /** Name of the tool, for `role: "tool"`. */
  name?: string;
}

/** Token accounting, per call and cumulative. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A tool call the model requested. */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Incremental streaming events. */
export type LLMStreamEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: LLMToolCall }
  | { type: "usage"; usage: LLMUsage };

/** Options for {@link LLMProvider.chat}. */
export interface LLMChatOptions {
  /** System prompt. Omit to continue without one. */
  system?: string;
  /** Prior turns, oldest first. */
  messages?: LLMMessage[];
  /** The new user utterance. */
  userMessage: string;
  /** Tools the model may call. */
  tools?: AgentTool[];
  /** Cancels the request, e.g. on barge-in. */
  signal?: AbortSignal;
  /** Cap on tool round-trips, to stop a model looping on the same call. */
  maxToolIterations?: number;
  /** Called for each streamed text delta. */
  onText?: (delta: string) => void;
  /** Deadline in ms. Default: 20000. */
  timeoutMs?: number;
}

/** The result of one {@link LLMProvider.chat} call. */
export interface LLMResult {
  /** The assistant's reply. */
  text: string;
  /** Tool calls made during the exchange, in order. */
  toolCalls: LLMToolCall[];
  /** Tokens consumed, when the provider reports them. */
  usage?: LLMUsage;
  /** Why generation stopped. */
  finishReason?: string;
}

/** An LLM backend. */
export interface LLMProvider {
  readonly name: string;
  /**
   * Runs one exchange: streams the reply, executing tool calls until the model
   * stops asking for them.
   */
  chat(options: LLMChatOptions): Promise<LLMResult>;
  /** Cumulative usage since construction, for per-call cost reporting. */
  totalUsage(): LLMUsage;
}

// ─── OpenAI-compatible implementation ──────────────────────────────────────

/** Options for {@link createOpenAILLM}. */
export interface OpenAILLMOptions {
  apiKey: string;
  /** Defaults to "gpt-4o-mini", a sensible voice-agent model. */
  model?: string;
  /** Defaults to "https://api.openai.com/v1". Any compatible endpoint works. */
  baseUrl?: string;
  /** Provider label used in errors. */
  name?: string;
  /** Sampling temperature. Default: 0.7, warm but not erratic. */
  temperature?: number;
  /** Cap on generated tokens. */
  maxTokens?: number;
  /**
   * Allow the model to stream tokens. Default: true.
   *
   * Off means one non-streaming round trip: higher first-token latency, but no
   * partial text if you don't need it.
   */
  stream?: boolean;
}

const EMPTY_USAGE: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * An LLM provider speaking the OpenAI chat-completions API.
 *
 * Works against OpenAI and any endpoint that is wire-compatible, which covers
 * most hosted models and every local server that exposes the same shape.
 */
export class OpenAILLM implements LLMProvider {
  readonly name: string;
  private readonly options: OpenAILLMOptions;
  private usage: LLMUsage = { ...EMPTY_USAGE };

  constructor(options: OpenAILLMOptions) {
    if (!options.apiKey) {
      throw new Error(
        "createOpenAILLM requires an apiKey — pass one, or use a provider that needs no key.",
      );
    }
    this.options = options;
    this.name = options.name ?? "openai";
  }

  totalUsage(): LLMUsage {
    return { ...this.usage };
  }

  async chat(options: LLMChatOptions): Promise<LLMResult> {
    const maxIterations = options.maxToolIterations ?? 4;
    const messages: LLMMessage[] = [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      ...(options.messages ?? []),
    ];

    const toolCalls: LLMToolCall[] = [];
    let totalUsage: LLMUsage = { ...EMPTY_USAGE };
    let lastText = "";
    // An unknown tool name will not become known on the next attempt. Without
    // this the loop spends every remaining iteration re-asking for it.
    let missingTool: string | undefined;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      if (options.signal?.aborted) break;

      const turn = await this.complete(messages, options);

      totalUsage = addUsage(totalUsage, turn.usage ?? EMPTY_USAGE);
      if (turn.text) lastText = turn.text;

      if (turn.toolCalls.length === 0 || missingTool) {
        this.usage = addUsage(this.usage, totalUsage);
        return {
          text: lastText,
          toolCalls,
          usage: totalUsage,
          finishReason: missingTool
            ? `unknown tool: ${missingTool}`
            : turn.finishReason,
        };
      }

      // Record the assistant's request so the model can see what it asked for.
      messages.push({ role: "assistant", content: turn.text || "", });
      for (const call of turn.toolCalls) {
        toolCalls.push(call);
        const result = await this.runTool(call, options, (name) => {
          missingTool = name;
        });
        messages.push({
          role: "tool",
          content: result,
          toolCallId: call.id,
          name: call.name,
        });
        // A barge-in during tool execution should stop the loop rather than
        // starting another model round trip nobody will hear.
        if (options.signal?.aborted) break;
      }
    }

    this.usage = addUsage(this.usage, totalUsage);
    return { text: lastText, toolCalls, usage: totalUsage, finishReason: "max_tool_iterations" };
  }

  /** Executes a tool call and renders the result as tool-message content. */
  private async runTool(
    call: LLMToolCall,
    options: LLMChatOptions,
    onMissing: (name: string) => void,
  ): Promise<string> {
    const tool = options.tools?.find((t) => t.name === call.name);
    if (!tool) {
      onMissing(call.name);
      return `Error: no tool named "${call.name}" is available.`;
    }
    try {
      const result = await tool.execute(call.arguments);
      return typeof result === "string" ? result : JSON.stringify(result ?? null);
    } catch (error) {
      // A failed tool is information for the model, not a fatal error: it can
      // recover and answer without the tool.
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** One model round trip, streaming or not. */
  private async complete(
    messages: LLMMessage[],
    options: LLMChatOptions,
  ): Promise<{ text: string; toolCalls: LLMToolCall[]; usage?: LLMUsage; finishReason?: string }> {
    const body: Record<string, unknown> = {
      model: this.options.model ?? "gpt-4o-mini",
      messages: messages.map(toWireMessage),
      temperature: this.options.temperature ?? 0.7,
    };
    if (this.options.maxTokens) body.max_tokens = this.options.maxTokens;
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (this.options.stream !== false) body.stream = true;
    if (this.options.stream !== false) body.stream_options = { include_usage: true };

    const streaming = this.options.stream !== false;
    const url = `${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;

    // Retried: an LLM round trip has no side effects, and a 503 at the start of
    // a turn is otherwise an audible silence.
    const handle = await retry(
      () =>
        fetchWithTimeout(url, {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 20_000,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.options.apiKey}`,
            },
            body: JSON.stringify(body),
          },
        }).then(async (attempt) => {
          if (attempt.response.ok) return attempt;
          const text = await attempt.response.text().catch(() => "");
          attempt.cancel();
          throw new Error(
            `${this.name} chat failed: ${attempt.response.status} ${attempt.response.statusText}${
              text ? ` — ${text.slice(0, 300)}` : ""
            }`,
          );
        }),
      // A caller abort is not a transient failure.
      { isRetryable: (error) => !isAbortError(error) },
    );

    if (!handle.response.body) {
      handle.cancel();
      throw new Error(`${this.name} returned no response body`);
    }

    try {
      return streaming
        ? this.readStream(handle.response, options)
        : await this.readJson(handle.response);
    } finally {
      handle.cancel();
    }
  }

  /** Parses the non-streaming shape. */
  private async readJson(
    response: Response,
  ): Promise<{ text: string; toolCalls: LLMToolCall[]; usage?: LLMUsage; finishReason?: string }> {
    const data = (await response.json()) as {
      choices?: Array<{ message?: WireMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      usage: data.usage ? toUsage(data.usage) : undefined,
      finishReason: choice?.finish_reason,
    };
  }

  /**
   * Parses the SSE stream.
   *
   * Tool calls arrive as deltas that must be reassembled: the name and the
   * first argument fragment come in one chunk, the rest in later ones, keyed by
   * index. Reading only the content field would drop every tool call.
   */
  private async readStream(
    response: Response,
    options: LLMChatOptions,
  ): Promise<{ text: string; toolCalls: LLMToolCall[]; usage?: LLMUsage; finishReason?: string }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    let text = "";
    let finishReason: string | undefined;
    let usage: LLMUsage | undefined;
    // Keyed by the call's index in the response, per the SSE protocol.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }

          if (chunk.usage) usage = toUsage(chunk.usage);
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (delta?.content) {
            text += delta.content;
            // Stream to the caller so the first audio can start early.
            options.onText?.(delta.content);
          }

          for (const call of delta?.tool_calls ?? []) {
            const existing = partial.get(call.index);
            const entry = existing ?? { id: "", name: "", args: "" };
            if (call.id) entry.id = call.id;
            if (call.function?.name) entry.name += call.function.name;
            if (call.function?.arguments) entry.args += call.function.arguments;
            partial.set(call.index, entry);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, entry]) => ({
        id: entry.id || `call_${index}`,
        name: entry.name,
        arguments: safeParseArgs(entry.args),
      }))
      .filter((c) => c.name);

    return { text, toolCalls, usage, finishReason };
  }
}

/** Factory for {@link OpenAILLM}. */
export function createOpenAILLM(options: OpenAILLMOptions): OpenAILLM {
  return new OpenAILLM(options);
}

// ─── Wire shapes ────────────────────────────────────────────────────────────

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function toWireMessage(message: LLMMessage): WireMessage {
  return {
    role: message.role,
    content: message.content || null,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

function toUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): LLMUsage {
  const promptTokens = raw.prompt_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
  };
}

function parseToolCalls(
  calls?: Array<{ id: string; function: { name: string; arguments: string } }>,
): LLMToolCall[] {
  return (calls ?? []).map((c, index) => ({
    id: c.id || `call_${index}`,
    name: c.function.name,
    arguments: safeParseArgs(c.function.arguments),
  }));
}

/**
 * Tool arguments arrive as a JSON string that a model may have truncated
 * mid-generation. Falling back to an empty object keeps the turn alive instead
 * of throwing away the whole reply.
 */
function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}

// ─── Conversation helpers ───────────────────────────────────────────────────

/** Converts framework turns to LLM messages, dropping empty entries. */
export function turnsToMessages(turns: ConversationTurn[]): LLMMessage[] {
  return turns
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({
      role: t.role === "agent" ? ("assistant" as const) : ("user" as const),
      content: t.content,
    }));
}
