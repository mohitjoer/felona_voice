<p align="center">
  <img src="https://raw.githubusercontent.com/felona-voice/felona-voice/main/public/logo.png" alt="Felona Voice" width="280" />
</p>

# 🎙️ Felona Voice Documentation

Welcome to the comprehensive documentation for **Felona Voice** — the ultra-low-latency, open-source voice agent framework powered by **Joint Embedding Vectors (JEV)**.

---

## 📚 Documentation Table of Contents

| Guide | Description |
| :--- | :--- |
| **[Installation & Setup Guide](./INSTALLATION.md)** | Step-by-step installation for npm, pnpm, bun, yarn, TypeScript ESM config, and audio provider setup. |
| **[Architecture & Core Principles](./ARCHITECTURE.md)** | Why Felona Voice routes with in-process vectors instead of a model call, audio pipeline flow, and latency comparison. |
| **[Complete API Reference](./API_REFERENCE.md)** | Exhaustive documentation of every class, function, method, interface, and configuration parameter. |
| **[API Reference — VoiceGraph](./API_REFERENCE.md#1-voicegraphtstate--compiledvoicegraphtstate)** | How to build stateful conversational graphs with directed edges and fallback protection. |
| **[API Reference — Visualization](./API_REFERENCE.md#4-visualization-functions-packagescoresrcgraphvisualizets)** | Generate instant Markdown (`.md`) diagrams, terminal ASCII flowcharts, and Mermaid diagrams via API or CLI. |
| **[API Reference — MCP Tools](./API_REFERENCE.md#9-mcp-tool-support-packagescoresrctoolsmcpts)** | Borrow tools from any MCP server and use them like native ones. |
| **[API Reference — OpenTelemetry](./API_REFERENCE.md#10-opentelemetry-tracing-packagescoresrcobservability)** | Span-per-turn tracing that stays a no-op until you register a provider. |
| **[API Reference — WebRTC](./API_REFERENCE.md#11-webrtc-transport-packagescoresrctransportwebrtcts)** | Browser and mobile clients: signalling, PCMU/RTP audio, barge-in. |
| **[API Reference — Call Analytics](./API_REFERENCE.md#8-call-analytics-packagescoresrcanalytics)** | Post-call outcome, sentiment and escalation scoring. |
| **[Telephony & Twilio Guide](./TELEPHONY_TWILIO_GUIDE.md)** | Connect voice agents to mobile phone calls via Twilio Media Streams, G.711 μ-law transcoding, and TwiML. **Webhook auth is now required.** |
| **[Changelog](../CHANGELOG.md)** | Release notes. v3.0.1 adds decision-model routing; v3.0.0 contains breaking changes to Twilio auth, concurrency defaults, and MCP environment inheritance. |
| **[Production Guide](./PRODUCTION.md)** | What is enforced by default, what you must configure, metrics, logging, cost tracking, guardrails, horizontal scaling, extension points, pre-flight checklist. |
| **[Agent Capabilities](./AGENT_CAPABILITIES.md)** | LLM-backed actions, background cancellation on interruption, non-blocking hooks, guardrails, voicemail detection, mid-call prompt override, noise cancellation, interruption tuning. |

---

## ⚡ 30-Second Quickstart

```bash
npm install felona-voice
```

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("Concierge")
  .system("You are an upscale hotel concierge.")
  .action("book_table", "Book restaurant reservation", async () => "Table booked for 7 PM!")
  .action("room_service", "Order fresh towels or food", async () => "Room service is on its way.")
  .fallback("Sorry, I am not able to understand that. How may I assist you?");

// 1. Simulate a turn instantly (sub-millisecond):
const reply = await agent.interact("can I get clean towels?");
console.log(reply.text); // "Room service is on its way."

// 2. Export documentation as Markdown:
console.log(agent.drawMarkdown());

// 3. Or start streaming WebSocket voice server:
// agent.listen({ port: 8080 });
```

---

## 🌟 Core Concepts at a Glance

1. **JEV Vector Routing**: Instead of passing every conversational turn to a slow, costly model, JEV encodes user utterances into a vector space and matches them against candidate actions via cosine similarity — sub-millisecond, in-process, no API key required by default.
2. **Deterministic & Safe**: Actions execute pure TypeScript/JavaScript code, database queries, or tool calls. No hallucinations, no unpredictable prompt drift.
3. **Stateful Conversation Graphs**: Build stateful conversational workflows using `.addNode()`, `.addEdge()`, and `.invoke()`.
4. **Markdown Native Visualization**: Generate diagrams that render automatically in GitHub, VS Code Markdown preview, and docs platforms with zero configuration.
