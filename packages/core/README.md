# 🎙️ Felona Voice (`felona-voice`)

[![npm version](https://img.shields.io/npm/v/felona-voice.svg?style=flat-square&color=3b82f6)](https://www.npmjs.com/package/felona-voice)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

**Open-source, ultra-low-latency voice agent framework powered by JEV (Joint Embedding Vectors) with LangGraph-style state machines.**

## Installation

```bash
npm install felona-voice
```

## Quick Start

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
console.log(reply.action.id); // "room_service"
```

## Features

- **JEV Routing**: Sub-10ms neural intent routing via local fast semantic embeddings or OpenAI embeddings.
- **Pure JavaScript Execution**: Deterministic responses without LLM latency, token cost, or hallucinations.
- **Pluggable Audio Stack**:
  - **STT**: Deepgram Nova-2, OpenAI Whisper, AssemblyAI, Azure Speech, Google Cloud Speech.
  - **TTS**: Cartesia Sonic (<100ms), Deepgram Aura, ElevenLabs, OpenAI Speech, Azure Speech, Amazon Polly, LMNT.
  - **VAD**: Zero-dependency energy-based speech boundary detection.
- **LangGraph-Style State Machines**: `VoiceGraph` with `.addNode()`, `.addEdge()`, `.compile()`, and `.invoke()`.
- **Markdown & Mermaid Visualization**: Automatic generation of architectural diagrams and transition tables.

## Documentation & Repository

For complete documentation, guides, and architectural overviews:
👉 [https://github.com/felona-voice/felona-voice](https://github.com/felona-voice/felona-voice#readme)

## License

MIT © Felona Voice Contributors
