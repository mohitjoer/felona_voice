/**
 * Anthropic Claude provider.
 *
 * Not covered by the OpenAI-compatible client: Claude's Messages API differs in
 * shape (a top-level `system` rather than a system message, `tool_use` blocks
 * rather than `tool_calls`, a different streaming event protocol). Anyone
 * building a voice agent on Claude had to hand-roll it in a handler, losing
 * cancellation and usage accounting.
 *
 * The same contract as {@link OpenAILLM}, so `builder.llm()` takes either.
 */

import { fetchWithTimeout, isAbortError } from "../resilience/timeout.js";
import { retry } from "../resilience/retry.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMToolCall,
  LLMUsage,
} from "./llm.js";
import type { AgentTool } from "../types.js";

/** Options for {@link createAnthropicLLM}. */
export interface AnthropicLLMOptions {
  apiKey: string;
  /** Defaults to a current small model, which suits a latency-sensitive call. */
  model?: string;
  /** Defaults to "https://api.anthropic.com". */
  baseUrl?: string;
  /** Sampling temperature. Default: 0.7. */
  temperature?: number;
  /** Cap on generated tokens. Default: 1024 — a spoken reply is short. */
  maxTokens?: number;
  /** Provider label used in errors. */
  name?: string;
  /**
   * Anthropic's prompt-caching beta. Off by default because cache reads are
   * priced differently from writes and the operator should opt in knowingly.
   */
  promptCaching?: boolean;
}

const EMPTY: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function merge(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** An LLM provider speaking the Anthropic Messages API. */
export class AnthropicLLM implements LLMProvider {
  readonly name: string;
  private readonly options: AnthropicLLMOptions;
  private usage: LLMUsage = { ...EMPTY };

  constructor(options: AnthropicLLMOptions) {
    if (!options.apiKey) {
      throw new Error("createAnthropicLLM requires an apiKey");
    }
    this.options = options;
    this.name = options.name ?? "anthropic";
  }

  totalUsage(): LLMUsage {
    return { ...this.usage };
  }

  async chat(options: LLMChatOptions): Promise<LLMResult> {
    const maxIterations = options.maxToolIterations ?? 4;
    // The assistant turn has to be replayed with its content blocks intact:
    // Claude matches a tool_result to its tool_use by block id, so flattening
    // the blocks to a string loses the link and the API rejects the request.
    const messages: WireMessage[] = (options.messages ?? [])
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));
    const toolCalls: LLMToolCall[] = [];
    let total: LLMUsage = { ...EMPTY };
    let lastText = "";
    let missingTool: string | undefined;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      if (options.signal?.aborted) break;

      const turn = await this.complete(messages, options);
      total = merge(total, turn.usage ?? EMPTY);
      if (turn.text) lastText = turn.text;

      if (turn.toolCalls.length === 0 || missingTool) {
        this.usage = merge(this.usage, total);
        return {
          text: lastText,
          toolCalls,
          usage: total,
          finishReason: missingTool ?? turn.finishReason,
        };
      }

      // Claude returns tool requests as content blocks, so the assistant turn
      // has to be replayed with the tool_use blocks intact or the model cannot
      // match the results to its own requests.
      messages.push({ role: "assistant", content: turn.rawContent });
      for (const call of turn.toolCalls) {
        toolCalls.push(call);
        const result = await this.runTool(call, options, (name) => {
          missingTool = name;
        });
        // A tool result is a user turn carrying a tool_result block.
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: result }],
        });
        if (options.signal?.aborted) break;
      }
    }

    this.usage = merge(this.usage, total);
    return { text: lastText, toolCalls, usage: total, finishReason: "max_tool_iterations" };
  }

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
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** One request/response round trip. Non-streaming: Claude's tool loop needs
   * the complete assistant turn before tool results can be sent back, so
   * streaming buys nothing here. */
  private async complete(
    messages: WireMessage[],
    options: LLMChatOptions,
  ): Promise<{
    text: string;
    toolCalls: LLMToolCall[];
    usage?: LLMUsage;
    finishReason?: string;
    rawContent: AnthropicBlock[];
  }> {
    const system = options.system;

    const body: Record<string, unknown> = {
      model: this.options.model ?? "claude-sonnet-4-5",
      max_tokens: this.options.maxTokens ?? 1024,
      temperature: this.options.temperature ?? 0.7,
      messages: [...messages, { role: "user", content: options.userMessage }],
    };
    if (system) body.system = system;
    if (this.options.promptCaching) {
      body.system = [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ];
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const url = `${this.options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;

    const handle = await retry(
      () =>
        fetchWithTimeout(url, {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 20_000,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.options.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
          },
        }).then(async (attempt) => {
          if (attempt.response.ok) return attempt;
          const text = await attempt.response.text().catch(() => "");
          attempt.cancel();
          throw new Error(
            `${this.name} request failed: ${attempt.response.status} ${attempt.response.statusText}${
              text ? ` — ${text.slice(0, 300)}` : ""
            }`,
          );
        }),
      { isRetryable: (error) => !isAbortError(error) },
    );

    try {
      const data = (await handle.response.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      const toolCalls: LLMToolCall[] = (data.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block, index) => ({
          id: block.id ?? `call_${index}`,
          name: block.name ?? "",
          arguments: (block.input as Record<string, unknown>) ?? {},
        }))
        .filter((c) => c.name);

      return {
        text,
        toolCalls,
        usage: data.usage ? toUsage(data.usage) : undefined,
        finishReason: data.stop_reason,
        // Replayed verbatim so tool_use ids line up with the results.
        rawContent: data.content ?? [],
      };
    } finally {
      handle.cancel();
    }
  }
}

/** Factory for {@link AnthropicLLM}. */
export function createAnthropicLLM(options: AnthropicLLMOptions): AnthropicLLM {
  return new AnthropicLLM(options);
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

/** A message in Claude's own shape, where content may be blocks. */
type WireMessage = {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
};

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toUsage(raw: { input_tokens?: number; output_tokens?: number }): LLMUsage {
  const promptTokens = raw.input_tokens ?? 0;
  const completionTokens = raw.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/** Convenience re-export so callers need only this module. */
export type { LLMChatOptions, LLMMessage, LLMProvider, LLMResult, LLMToolCall, LLMUsage };
export type { AgentTool };
