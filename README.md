<p align="center">
  <img src="./public/logo.png" alt="Felona Voice" width="300" />
</p>

<p align="center">
  <strong>Sub-10ms Voice Agent Framework powered by Joint Embedding Vectors (JEV)</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/felona-voice"><img src="https://img.shields.io/npm/v/felona-voice.svg?style=flat-square&color=3b82f6" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square" alt="License: MIT" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.5-blue.svg?style=flat-square" alt="TypeScript" /></a>
  <a href="./packages/core/tests"><img src="https://img.shields.io/badge/tests-62%20passed-brightgreen.svg?style=flat-square" alt="Tests" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A520.0.0-green.svg?style=flat-square" alt="Node.js" /></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-violet.svg?style=flat-square" alt="PRs Welcome" /></a>
</p>

**Open-source, ultra-low-latency voice agent framework powered by JEV (Joint Embedding Vectors) with LangGraph-style state machines.**

Build conversational voice agents that decide what to do next with sub-10ms neural routing — combined with stateful transition graphs, pluggable audio pipelines, and automatic Markdown visualization.

## What Makes This Different

| Approach | How It Decides | Decision Latency | Extensibility |
|:---|:---|:---|:---|
| **Felona / JEV** | Embedding similarity → Next-Node Match | **~5ms** | ✅ Learns & generalizes |
| Graph-based (Static) | Hardcoded rule branches | ~10ms | ❌ Fragile to off-script speech |
| Pure LLM Prompts | Full prompt generation loop | ~500ms+ | ❌ Expensive & high latency |

**JEV predicts actions in ~5ms with zero LLM token latency. Deterministic, hallucination-free, ultra-low-cost conversational turns.**

## Quick Start

```bash
npm install felona-voice
```

> 📖 *For pnpm, bun, yarn, CLI setup, and TypeScript config, see the **[Full Installation Guide](./docs/INSTALLATION.md)**.*

### Option A: Fluent Builder (Recommended — 3 lines)

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("Concierge")
  .system("You are a friendly concierge.")
  .action("book_table", "Book a dining table or restaurant reservation", async () => "Table booked for 7 PM!")
  .action("room_service", "Order food or fresh towels", async () => "Room service is on its way.")
  .fallback("Sorry, I am not able to understand that. How can I assist you?");

// Test instantly without spinning up a server (zero external API keys required!):
const reply = await agent.interact("can I get clean towels?");
console.log(reply.text); // "Room service is on its way."

// Or start a live WebSocket voice audio server:
// agent.listen({ port: 8080 });
```

### Option B: Ready-to-Use Templates

```typescript
import { createSupportAgent } from "felona-voice";

const support = createSupportAgent({
  companyName: "Acme Corp",
  orderLookup: async (orderId) => ({ status: "out for delivery", eta: "today 4 PM" }),
});

const reply = await support.interact("Where is my package ACM-9281?");
console.log(reply.text);
// "Your order ACM-9281 is currently out for delivery and scheduled to arrive today 4 PM."
```

### Option C: Declarative Class Config

```typescript
import { FelAgent, defineAction } from "felona-voice";

const agent = new FelAgent({
  name: "My Agent",
  systemPrompt: "You are a helpful voice assistant.",
  stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
  tts: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY, voice: "aura-asteria-en" },
  actions: [
    defineAction({
      id: "greet",
      description: "Greet the user warmly and ask how you can help",
      handler: async () => "Hello! How can I help you today?",
    }),
  ],
});

agent.listen({ port: 8080 });
```

## 🗺️ Graph Visualization (Markdown, Mermaid & Terminal)

Felona Voice makes inspecting and documenting your voice agents effortless:

### 1. Generate Markdown Documentation (.md)
Create clean, comprehensive markdown documentation with embedded Mermaid diagrams, transition tables, and node catalogs that render directly in GitHub and VS Code:

```typescript
// Get markdown string:
const md = workflow.drawMarkdown();

// Or automatically generate and save a .md file:
await workflow.visualize({ outputPath: "./agent-graph.md" });
```

### 2. Terminal ASCII Flowchart
Inspired by LangGraph's `.draw_ascii()`:

```typescript
console.log(workflow.drawAscii());
```

### 3. One-line CLI Command
```bash
# Generate Markdown documentation file (.md):
npx felona visualize my-agent.ts --md

# Print terminal ASCII flowchart:
npx felona visualize my-agent.ts

# Output Mermaid syntax or Live Editor URL:
npx felona visualize my-agent.ts --mermaid
npx felona visualize my-agent.ts --url
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
├── core/          # Framework kernel (FelAgent, JEV, VoiceGraph, Visualizers)
└── cli/           # Developer CLI (felona-cli — visualize, scaffold, dev)
examples/
├── basic-greeting/     # Minimal 3-action starter agent
├── customer-support/   # Multi-action support agent with tool calling
└── voice-graph-flow/   # LangGraph-style stateful conversation flow

## Roadmap

- [x] **Phase 1**: Core framework — JEV engine, VoiceGraph, streaming audio pipeline, Deepgram STT/TTS, ElevenLabs TTS, OpenAI LLM
- [x] **Phase 1.5**: LangGraph-inspired state machines, fluent builders, Markdown & ASCII graph visualizer
- [ ] **Phase 2**: JEV predictor training from call logs, WebRTC transport
- [ ] **Phase 3**: YAML declarative agent configs, analytics dashboard
- [ ] **Phase 4**: Interactive visual canvas agent builder

## 🤝 Contributing

We love contributions! Check out [CONTRIBUTING.md](./CONTRIBUTING.md) to get started with local development. Please make sure to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## 📄 License

[MIT](./LICENSE) © 2026 Felona Voice Contributors
