# Felona Voice

**Open-source voice agent framework powered by JEV (Joint Embedding Vectors).**

Build intelligent voice agents that dynamically decide what to do next — no hardcoded conversation graphs, no static decision trees. JEV predicts the right action based on conversation context, then hands off to an LLM for natural language generation.

## What Makes This Different

| Approach | How It Decides | Latency | Learns |
|----------|---------------|---------|--------|
| **Felona/JEV** | Embedding similarity → action match | ~5ms | ✅ From call logs |
| Graph-based | Developer-defined nodes/edges | ~10ms | ❌ Static |
| Pure LLM | Prompt engineering | ~500ms+ | ❌ Manual |

**JEV decides _what_ to do. The LLM decides _how_ to say it.**

## Quick Start

```bash
npm install felona-voice
```

```typescript
import { FelAgent, defineAction } from "felona-voice";

const agent = new FelAgent({
  name: "My Agent",
  systemPrompt: "You are a helpful voice assistant.",
  stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
  tts: { provider: "elevenlabs", apiKey: process.env.ELEVEN_API_KEY },
  llm: { provider: "openai", apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" },
  actions: [
    defineAction({
      id: "greet",
      description: "Greet the user warmly and ask how you can help",
      handler: async (ctx) => {
        return ctx.llm.generate("Greet the user.", {
          systemPrompt: ctx.conversation.systemPrompt,
        });
      },
    }),
    defineAction({
      id: "help",
      description: "Help the user with their question",
      handler: async (ctx) => {
        return ctx.llm.generate(
          `Help the user. They said: "${ctx.conversation.currentUtterance}"`,
          {
            systemPrompt: ctx.conversation.systemPrompt,
            history: ctx.memory.getRecentTurns(10).map(t => ({
              role: t.role === "user" ? "user" : "assistant",
              content: t.content,
            })),
          },
        );
      },
    }),
  ],
});

agent.listen({ port: 8080 });
```

## How JEV Works

```
User speaks → STT → "I need help with my order"
                          ↓
              JEV Engine: encode(context) → predict(next_state) → match(action_space)
                          ↓
              Selected: "lookup_order" (confidence: 0.87)
                          ↓
              Action handler calls LLM: "Help the user look up their order..."
                          ↓
              LLM generates natural response → TTS → Agent speaks
```

1. **Context Encoder**: Embeds conversation history + current utterance into a vector
2. **Predictor** (optional): Trained MLP that transforms context → predicted next-state
3. **Action Matcher**: Cosine similarity against pre-embedded action descriptions
4. **Action Handler**: Executes the matched action (usually calls LLM for content)

Cold-start mode (no predictor) works out of the box. As you collect call logs, train the predictor for better accuracy.

## Architecture

```
Audio In → VAD → STT → JEV Decision → LLM Generate → TTS → Audio Out
                              ↕
                      Conversation Memory
```

### Built-in Providers

| Component | Providers |
|-----------|-----------|
| **STT** | Deepgram (streaming) |
| **TTS** | ElevenLabs (streaming) |
| **LLM** | OpenAI |
| **VAD** | Energy-based (zero-dependency) |
| **Embeddings** | OpenAI text-embedding-3-small |
| **Transport** | WebSocket |

All providers implement pluggable interfaces — bring your own.

## Examples

- [`basic-greeting`](./examples/basic-greeting/) — Simplest possible agent (3 actions)
- [`customer-support`](./examples/customer-support/) — Multi-action agent with tool calling

## Project Structure

```
packages/
├── core/          # Framework kernel (FelAgent, JEV, Pipeline, Providers)
└── cli/           # CLI tool (coming in Phase 2)
examples/
├── basic-greeting/
└── customer-support/
```

## Roadmap

- [x] **Phase 1**: Core framework — JEV engine, voice pipeline, STT/TTS/LLM providers
- [ ] **Phase 2**: JEV predictor training, CLI tooling, additional providers
- [ ] **Phase 3**: YAML config agents, analytics dashboard, docs site
- [ ] **Phase 4**: Visual Studio UI builder

## License

MIT
