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
  <a href="./packages/core/tests"><img src="https://img.shields.io/badge/tests-627%20passed-brightgreen.svg?style=flat-square" alt="Tests" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A520.0.0-green.svg?style=flat-square" alt="Node.js" /></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-violet.svg?style=flat-square" alt="PRs Welcome" /></a>
</p>

**Open-source, ultra-low-latency voice agent framework powered by JEV (Joint Embedding Vectors) with stateful conversational graphs.**

Build conversational voice agents that decide what to do next with in-process vector routing — combined with stateful transition graphs, pluggable audio pipelines, and automatic Markdown visualization.

## What Makes This Different

| Approach | How It Decides | Routing Latency | Extensibility |
|:---|:---|:---|:---|
| **Felona / JEV** | Embedding similarity → next-node match | **Sub-millisecond**, in-process | ✅ Generalizes across phrasings |
| Graph-based (Static) | Hardcoded rule branches | ~0ms | ❌ Fragile to off-script speech |
| LLM Decides Everything | Full prompt generation loop | ~500ms+ | ❌ Expensive & high latency |

**JEV picks the action with no model call in the loop, and routes deterministically — a below-threshold match goes to your `fallback` action instead of improvising.** Action handlers return the exact string sent to TTS, so a turn can be a fixed string or whatever your handler computes (including a call to a language model, if you want free-form phrasing).

> The built-in `FastSemanticEmbeddingProvider` is a deterministic lexical embedder (keyword anchors + character n-grams), not a neural network — routing is fast because it is in-process arithmetic. Pass `jev.embeddingProvider: "openai"` or your own `EmbeddingProvider` for neural embeddings.

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
Render graph structures directly in your CLI:

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
              Action handler runs: look up the order, format a reply
                          ↓
              TTS → Agent speaks
```

1. **Context Encoder**: Fuses the current utterance (82%) with recent user turns (18%) into one vector
2. **Predictor** (planned, not in this release): a trained model that transforms context → predicted next state. `jev.predictorModel` currently throws rather than pretending to work
3. **Action Matcher**: Cosine similarity against pre-embedded action descriptions
4. **Action Handler**: Your TypeScript. Returns the text that goes straight to TTS

Routing is deterministic. If the top match falls below `jev.confidenceThreshold` (default `0.35`), or is ambiguous, the `fallback` action runs instead — so an unrecognized utterance has a defined behaviour rather than an improvised one.

### Decision-model routing

Steps 1–3 above are the default and stay entirely in-process. You can swap step 3 for a **decision model**: a backend that answers bounded questions with probabilities instead of generating text. Your actions become the options of one choice question, so the routing space is unchanged — what changes is that each turn comes back with a probability per action rather than a similarity.

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("Support")
  .action("order_status", "Check delivery status, tracking or delivery ETA for an order", async (ctx) => {
    const order = await ctx.memory.getSlot("orderId");
    return `Order ${order} shipped Tuesday and arrives Friday.`;
  })
  .action("refund", "Process a refund, return, or billing dispute", async () => "Starting your refund now.")
  .fallback("Let me get someone who can help with that.")
  .decision({
    provider: "systemone",
    apiKey: process.env.SYSTEM_ONE_API_KEY,
    model: "jev-1.13.0",
  });
```

`.decision()` takes `provider: "systemone"` — the System One wire protocol — which the hosted service serves and so do most self-hosted decision servers, so pointing `baseUrl` at a local one is the only change needed. Pass a `DecisionProvider` instance instead to use your own backend.

Worth it when you have labelled examples for your own action set, or want scores you can gate on directly. It costs a network hop per turn and depends on that endpoint being reachable.

Two things to know before you tune against it:

- **Pin an exact model version.** A release can shift probabilities under a threshold you already set. A moving alias makes that shift invisible.
- **Recalibrate `confidenceThreshold`.** A decision model reports how concentrated its distribution is, which is not the same quantity as a cosine similarity. A threshold carried over from local routing is not automatically right.

If the call fails, the turn routes to `fallback` rather than failing — set `onError: "throw"` to make a misconfigured deployment loud instead.

**Generating replies with a language model:** the framework has no built-in LLM provider. Call your provider of choice inside an action handler and return its output; routing stays fast while phrasing is generated. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Architecture

```
Audio In → VAD → STT → JEV Decision → Action Handler → TTS → Audio Out
                              ↕
                      Conversation Memory
```

### Built-in Providers

| Component | Providers |
|-----------|-----------|
| **STT** | Deepgram (streaming), Whisper, AssemblyAI, Azure, Google |
| **TTS** | ElevenLabs, Deepgram Aura, Cartesia Sonic, OpenAI, Azure, Polly, LMNT |
| **Content** | Your action handlers — call any LLM/DB/API you like |
| **VAD** | Energy-based (zero-dependency) |
| **Embeddings** | OpenAI text-embedding-3-small, FastSemanticEmbedding |
| **Decisions** | System One protocol (`.decision()`), or your own `DecisionProvider` |
| **Transport** | WebSocket, Twilio Telephony (Media Streams), WebRTC (browser/mobile) |
| **Turn taking** | Energy VAD, STT endpointing, adaptive interruption, DTMF keypad |
| **Slots** | Name, email, phone, address, ZIP, date, card (Luhn-checked) — spoken-input aware |
| **Testing** | Declarable regression scenarios (`felona test`), wired into CI |
| **Knowledge** | In-memory vector retrieval over your docs, reusing the JEV embedder |
| **Tools** | Native `ToolRegistry`, plus any MCP server over JSON-RPC (zero dependencies) |
| **Observability** | OpenTelemetry spans for every turn, routing decision, handler, tool call and TTS |
| **Analytics** | Post-call outcome, sentiment, escalation risk and per-action confidence |
| **Telephony** | Twilio, Telnyx (G.711 μ-law transcoding, TwiML auto-serve) |

All providers implement pluggable interfaces — bring your own.

## Telephony & Mobile Calling (Twilio)

```typescript
import { createAgent } from "felona-voice";

const phoneAgent = createAgent("PhoneReceptionist")
  .system("You are a friendly customer service phone receptionist.")
  .action("hours", "Store opening and closing hours", "We are open Monday through Friday 9 AM to 6 PM.")
  .fallback("How can I assist your call today?")
  .twilio({
    port: 8080,
    greeting: "Thank you for calling. Connecting to customer service.",
  });

// Starts WebSocket stream at /media & auto-serves TwiML at /voice
await phoneAgent.listenTwilio({ port: 8080 });
```
👉 See [Telephony & Twilio Guide](./docs/TELEPHONY_TWILIO_GUIDE.md) for full instructions, Express middleware integration, and outbound calling.

## Tools via MCP

Borrow tools from any [MCP](https://modelcontextprotocol.io) server and call them like native ones. No SDK dependency — the client speaks JSON-RPC 2.0 over stdio directly.

```typescript
import { createAgent, createMcpClient } from "felona-voice";

const weather = createMcpClient({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-weather"],
  env: { OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY },
  namePrefix: "wx_",
});

const agent = await createAgent("Support")
  .action("check_weather", "Check the weather in a city", async (ctx) => {
    const result = await ctx.tools.call("wx_get_weather", { city: "Leeds" });
    return `It is currently ${result.summary}.`;
  })
  .mcp(weather)
  .connectMcp();          // connectMcp(), not build() — listing a server is async
```

Tools are validated before they reach the LLM, a tool that reports failure throws rather than being read aloud, and a wedged server times out instead of hanging the call.

## OpenTelemetry Tracing

Spans for every turn, routing decision, action handler, tool call and TTS synthesis. Built on the OpenTelemetry **API** only, so with no tracer provider registered it is a no-op and costs nothing.

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();
```

A turn's spans nest — `felona.turn` → `felona.jev.decide` → `felona.action.handle` → `felona.tool.call` — which is what makes a slow reply explainable. **Transcript text is never written to a span**: turns are identified by a short SHA-256 fingerprint and a character count, because spans are stored by whatever backend you choose, usually far longer than the call.

## WebRTC Transport

For browser and mobile clients, where the media path is already encrypted and already handles NAT traversal.

```typescript
const agent = createAgent("Browser Assistant")
  .transport({ type: "webrtc", port: 8080, authToken: process.env.SIGNALLING_TOKEN })
  .build();
```

The transport serves a small signalling endpoint (`POST /offer`, `POST /offer/ice`) and carries **PCMU μ-law at 8 kHz as RTP** in both directions — the same G.711 code the telephony path already uses, so a deployment running both converts audio once. The answer deliberately offers PCMU only, because that is the only codec the inbound path decodes.

Set `authToken` for anything reachable off-box: the media is DTLS-SRTP encrypted, but the signalling endpoint is plain HTTP and will otherwise hand out peer connections freely.

## Post-call Analytics

```typescript
const agent = createAgent("Support")
  .analysis({
    successActions: ["order_confirmed", "refund_issued"],
    escalationActions: ["transfer_human"],
  })
  .build();

agent.on("callAnalysis", (a) => console.log(a.summary, a.resolved, a.outcomeScore));
```

Without `analysis()`, the outcome is inferred from the transcript alone. Naming the actions that end well — or passing `resolve` when your systems know the real outcome — is what makes the result trustworthy enough to bill or escalate on.

## Examples

- [`basic-greeting`](./examples/basic-greeting/) — Simplest possible agent (3 actions)
- [`customer-support`](./examples/customer-support/) — Multi-action agent with tool calling
- [`voice-graph-flow`](./examples/voice-graph-flow/) — Stateful conversation graph flow example
- [`twilio-phone-agent`](./examples/twilio-phone-agent/) — Live mobile phone agent with Twilio Media Streams
- [`scenarios.ts`](./examples/scenarios.ts) — Regression scenarios (`npx felona test ./examples/scenarios.ts`)

## Project Structure

```
packages/
├── core/
│   └── src/
│       ├── jev/            # Joint Embedding Vector engine
│       ├── transport/      # WebSocket, WebRTC (RTP/PCMU) transports
│       ├── telephony/      # Twilio, G.711 transcoding, call transfer
│       ├── stt/ tts/ vad/  # Pluggable providers
│       ├── slots/ i18n/    # Slot collection, language policy
│       ├── knowledge/      # In-memory vector retrieval
│       ├── supervision/    # Transfer and escalation handling
│       ├── tools/          # ToolRegistry + MCP client
│       ├── observability/  # OpenTelemetry tracing
│       ├── analytics/      # Post-call outcome & sentiment
│       └── testing/        # Scenario runner
└── cli/           # Developer CLI (felona-cli — visualize, scaffold, dev, test)
examples/
├── basic-greeting/     # Minimal 3-action starter agent
├── customer-support/   # Multi-action support agent with tool calling
└── voice-graph-flow/   # Stateful conversation graph flow example

## Production Readiness

Defaults that are enforced without configuration: a finite concurrency ceiling,
a maximum call duration, deadlines and retry on every outbound request, capped
per-call audio buffers, aborted TTS bodies on barge-in, and a TTS stream that is
cancelled rather than abandoned. Metrics, JSON logging, per-call cost tracking,
guardrails, and answering-machine detection are opt-in.

Start with **[docs/PRODUCTION.md](./docs/PRODUCTION.md)** — it covers what the
framework does *not* do for you (rate limiting, compliance, load testing) as
well, because those are the parts that are easy to assume.

Newer capabilities: **[docs/AGENT_CAPABILITIES.md](./docs/AGENT_CAPABILITIES.md)**
(LLM-backed actions, background cancellation, guardrails, voicemail detection).

> ⚠️ **Breaking:** Twilio webhook signature validation now fails closed. See
> [the telephony guide](./docs/TELEPHONY_TWILIO_GUIDE.md#breaking-change-webhook-authentication-is-now-required).

## Roadmap

- [x] **Phase 1**: Core framework — JEV engine, VoiceGraph, streaming audio pipeline, Deepgram/Whisper/AssemblyAI/Azure/Google STT, ElevenLabs/Deepgram/OpenAI/Cartesia/Azure/Polly/LMNT TTS, Twilio telephony, G.711 μ-law + A-law transcoding
- [x] **Phase 1.5**: Stateful conversation graphs, fluent builders, Markdown & ASCII graph visualizer
- [x] **Phase 2**: WebRTC transport (signalling, PCMU/RTP packetization, barge-in), MCP tool support, OpenTelemetry tracing, post-call outcome & sentiment scoring
- [ ] **Phase 2b**: JEV predictor training from call logs, built-in LLM content provider
- [ ] **Phase 3**: YAML declarative agent configs, analytics dashboard
- [ ] **Phase 4**: Interactive visual canvas agent builder

## 🤝 Contributing

We love contributions! Check out [CONTRIBUTING.md](./CONTRIBUTING.md) to get started with local development. Please make sure to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

## 📄 License & Attribution

Licensed under the **MIT License with Attribution Requirement**. See [LICENSE](./LICENSE) for full details.

You are free to use, modify, and distribute this software for both personal and commercial projects. However, **visible attribution is legally required**:
- Any application, SaaS, website, documentation, or product powered by Felona Voice must prominently display:
  > **"Powered by Felona Voice"** or **"Built with Felona Voice"** with a direct link to [https://github.com/felona-voice/felona-voice](https://github.com/felona-voice/felona-voice).
- Credit can be placed in your product interface (footer, about screen, or settings), landing page, or documentation.

© 2026 Mohit & Felona Voice Contributors
