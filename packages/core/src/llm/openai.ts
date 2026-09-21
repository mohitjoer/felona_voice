import type { LLMProvider, LLMInterface, LLMOptions, LLMContext } from "../types.js";

/**
 * OpenAILLM — LLM provider using OpenAI's chat completions API.
 *
 * The LLM in Felona Voice is used for **content generation**, not flow control.
 * JEV decides what to do; the LLM decides how to say it.
 */
export class OpenAILLM implements LLMProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; baseUrl?: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  create(options: LLMOptions): LLMInterface {
    return new OpenAILLMInterface({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: options.model,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 256,
    });
  }
}

class OpenAILLMInterface implements LLMInterface {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
  }

  async generate(prompt: string, context?: LLMContext): Promise<string> {
    const messages = this.buildMessages(prompt, context);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI LLM failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  }

  async *generateStream(
    prompt: string,
    context?: LLMContext,
  ): AsyncIterable<string> {
    const messages = this.buildMessages(prompt, context);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI LLM stream failed: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("OpenAI LLM returned no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") return;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // Ignore malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildMessages(
    prompt: string,
    context?: LLMContext,
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // System prompt
    if (context?.systemPrompt) {
      messages.push({ role: "system", content: context.systemPrompt });
    }

    // Additional instructions
    if (context?.instructions) {
      messages.push({ role: "system", content: context.instructions });
    }

    // Conversation history
    if (context?.history) {
      messages.push(...context.history);
    }

    // The actual prompt (what JEV decided the agent should do)
    messages.push({ role: "user", content: prompt });

    return messages;
  }
}

export function createOpenAILLM(options: {
  apiKey: string;
  baseUrl?: string;
}): OpenAILLM {
  return new OpenAILLM(options);
}
