# 🎙️ Felona Voice Documentation

Welcome to the comprehensive documentation for **Felona Voice** — the ultra-low-latency, open-source voice agent framework powered by **Joint Embedding Vectors (JEV)**.

---

## 📚 Documentation Table of Contents

| Guide | Description |
| :--- | :--- |
| **[Architecture & Core Principles](./ARCHITECTURE.md)** | Why Felona Voice is 100% LLM-free, ~5ms neural action routing, audio pipeline flow, and latency comparison. |
| **[Complete API Reference](./API_REFERENCE.md)** | Exhaustive documentation of every class, function, method, interface, and configuration parameter. |
| **[VoiceGraph Guide](./VOICE_GRAPH_GUIDE.md)** | How to build LangGraph-style stateful conversation machines, directed edges, and fallback protection. |
| **[Graph Visualization Guide](./VISUALIZATION_GUIDE.md)** | Generate instant Markdown (`.md`) diagrams, terminal ASCII flowcharts, and Mermaid diagrams via API or CLI. |

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

1. **JEV Neural Routing**: Instead of passing conversational turns to a slow, costly LLM, JEV encodes user utterances into a semantic vector space and matches them against candidate actions via cosine similarity in **~5 milliseconds**.
2. **Deterministic & Safe**: Actions execute pure TypeScript/JavaScript code, database queries, or tool calls. No hallucinations, no unpredictable prompt drift.
3. **LangGraph-Style State Machine**: Build stateful conversational graphs using `.addNode()`, `.addEdge()`, and `.invoke()`.
4. **Markdown Native Visualization**: Generate diagrams that render automatically in GitHub, VS Code Markdown preview, and docs platforms with zero configuration.
