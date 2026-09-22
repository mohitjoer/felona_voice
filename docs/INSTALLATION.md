<p align="center">
  <img src="https://raw.githubusercontent.com/felona-voice/felona-voice/main/public/logo.png" alt="Felona Voice" width="300" />
</p>

# 📦 Installation & Setup Guide

This guide walks you through installing **Felona Voice** (`felona-voice`) and the companion CLI tool (**`felona-cli`**), configuring your environment, and verifying your installation in under 60 seconds.

---

## 📋 System Prerequisites

| Requirement | Minimum Version | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 20.0.0` | `20.x` or `22.x LTS` | Requires native WebStreams, `fetch`, and `FormData` |
| **Package Manager** | `npm` 9+, `pnpm` 8+, `bun` 1.1+, or `yarn` | `npm` / `bun` | Works across all modern package managers |
| **TypeScript** | `>= 5.0.0` | `5.5+` | Recommended for full type safety |
| **Module System** | ESM (`"type": "module"`) | ESM | Felona Voice is published as pure modern ESM |

---

## 🚀 1. Install the Core Framework

Install `felona-voice` in your project:

### Using npm
```bash
npm install felona-voice
```

### Using pnpm
```bash
pnpm add felona-voice
```

### Using Bun
```bash
bun add felona-voice
```

### Using Yarn
```bash
yarn add felona-voice
```

---

## 🛠️ 2. Install the CLI Tool (`felona-cli`)

The CLI allows you to inspect conversational graphs, render terminal ASCII flowcharts, and auto-generate Markdown/Mermaid architecture diagrams:

### Global Installation
```bash
npm install -g felona-cli
```

### Or Run On-the-Fly with npx / bunx
```bash
# Generate Markdown diagram & transition specs
npx felona-cli visualize ./src/agent.ts --md

# Render terminal ASCII box diagram
npx felona-cli visualize ./src/agent.ts --ascii

# Launch interactive browser visualizer
npx felona-cli visualize ./src/agent.ts --open
```

---

## ⚙️ 3. TypeScript Configuration (`tsconfig.json`)

Felona Voice is built as a pure modern ESM package. Ensure your `tsconfig.json` has `moduleResolution` configured for Node ESM:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
```

> [!TIP]
> If you are using a framework with a bundler (Next.js, Vite, or Bun), `"moduleResolution": "bundler"` is also fully supported.

---

## 🧪 4. Verify Installation in 3 Lines (Zero API Keys Needed)

Create a test file `test-felona.ts` (or `.js`):

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("TestBot")
  .action("ping", "Health check or ping greeting", () => "Pong! System operational.")
  .fallback("Unrecognized query.");

const reply = await agent.interact("can you ping the server?");
console.log(`Action Matched: ${reply.action.id}`); // "ping"
console.log(`Response: ${reply.text}`);           // "Pong! System operational."
console.log(`Latency: ${reply.telemetry.latencyMs}ms`); // ~1ms - 5ms
```

Run it immediately:
```bash
npx tsx test-felona.ts
# or with Bun:
bun test-felona.ts
```

If you see `Action Matched: ping`, your JEV embedding engine is working properly with zero external API dependencies!

---

## 🔑 5. Environment Variables (Audio Providers)

To connect live streaming audio for voice calls, add the API keys for your preferred STT and TTS providers to your `.env` file:

```env
# ─── Speech-to-Text (Choose any) ──────────────────────────
DEEPGRAM_API_KEY=your_deepgram_key          # Deepgram Nova-2 (WebSocket streaming)
OPENAI_API_KEY=your_openai_key              # OpenAI Whisper STT
ASSEMBLYAI_API_KEY=your_assemblyai_key      # AssemblyAI Streaming STT
AZURE_SPEECH_KEY=your_azure_key             # Microsoft Azure Cognitive Speech
AZURE_SPEECH_REGION=eastus                  # Azure region

# ─── Text-to-Speech (Choose any) ──────────────────────────
CARTESIA_API_KEY=your_cartesia_key          # Cartesia Sonic (<100ms ultra-low latency)
ELEVEN_API_KEY=your_elevenlabs_key          # ElevenLabs Turbo
LMNT_API_KEY=your_lmnt_key                  # LMNT Speech
```

### Wiring Providers into Your Agent:

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("SupportBot")
  // STT: choose Deepgram, Whisper, AssemblyAI, Azure, or Google
  .deepgram({ apiKey: process.env.DEEPGRAM_API_KEY! })

  // TTS: choose Cartesia, ElevenLabs, Deepgram Aura, OpenAI, Azure, Polly, or LMNT
  .cartesia({ 
    apiKey: process.env.CARTESIA_API_KEY!,
    voice: "a0e99841-438c-4a64-b679-ae501e7d6091" 
  })

  .action("order_status", "Check delivery date or shipment status", async (ctx) => {
    return "Your order is scheduled for delivery today before 4:30 PM.";
  })
  .fallback("Could you please repeat that?");

// Start WebSocket audio stream server
await agent.listen({ port: 8080 });
console.log("Agent listening for audio streams on ws://localhost:8080");
```

---

## 🧩 6. Optional Dependencies

### Predictor Neural Network (ONNX Runtime)
If you want to train and load an offline MLP predictor network instead of cosine vector matching:

```bash
npm install onnxruntime-node
```

Felona Voice automatically checks if `onnxruntime-node` is present and enables hardware-accelerated ONNX graph evaluation.

---

## 🔍 Common Troubleshooting

### 1. `Cannot find module 'felona-voice'`
- Ensure Node.js version is `>= 20.0.0`:
  ```bash
  node -v
  ```
- Make sure `"type": "module"` is set in your root `package.json`.

### 2. TypeScript Error: `Module Resolution NodeNext`
- If using `ts-node`, use `tsx` instead for seamless modern ESM and TypeScript execution:
  ```bash
  npx tsx your-agent.ts
  ```

---

## 📚 Next Steps

- Check out the **[Architecture & Core Principles](./ARCHITECTURE.md)** to understand how JEV predicts actions in ~5ms.
- Explore the **[Complete API Reference](./API_REFERENCE.md)** for full class and configuration details.
- Read the **[VoiceGraph Guide](./VOICE_GRAPH_GUIDE.md)** to build stateful conversational graphs.
