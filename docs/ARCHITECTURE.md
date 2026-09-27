# 🏗️ Architecture & Core Principles

Felona Voice is designed from the ground up for **ultra-low-latency, real-time voice interactions**.

Felona Voice lets you decide *what* to do separately from *how* to respond. JEV (Joint Embedding Vectors) routes the conversation, and an action handler produces the reply. The framework does not require a language model — but it does not prevent you from calling one inside a handler, which is the recommended pattern when replies need free-form language.

---

## 🎯 Why Route with Vectors?

In voice applications, **latency is everything**. Humans perceive conversational gaps larger than 200–300 milliseconds as awkward or unresponsive.

| Dimension | LLM-Decides-Everything Agents | Felona Voice (JEV Engine) |
| :--- | :--- | :--- |
| **Routing Latency** | 400ms – 1,200ms per turn | **Sub-millisecond** (in-process cosine similarity over 128-d vectors) |
| **Cost** | Input/output token pricing per turn | **$0.00** for routing with the built-in provider |
| **Predictability** | Prone to hallucinating a transition that does not exist | Routing is **deterministic**; below-threshold matches go to `fallback` |
| **Dependencies** | Requires a model API for routing | **None** for routing (built-in embedding provider, no API key) |
| **Debugging** | Hard to trace prompt logic | Inspectable candidate scores, confidence and latency per turn |

**JEV decides which action to take, then the action handler returns the exact string handed to TTS.** If that handler calls an LLM to phrase the reply, you pay the LLM's latency there — JEV only removes it from the *routing* decision.

> **On the "~5ms neural routing" claim.** The built-in `FastSemanticEmbeddingProvider` is a deterministic lexical embedder — weighted keyword anchors, character 3-grams and word hashes — not a neural network. Routing is fast because it is in-process arithmetic, not because a model runs. Swap in `jev.embeddingProvider: "openai"` (or your own `EmbeddingProvider`) for neural embeddings; that moves the cost to the embedding API.

---

## 🔄 End-to-End Voice Pipeline

```
Audio In (PCM16)
       ↓
┌──────────────┐
│  Energy VAD  │  → Detects voice activity and pauses (turn segmentation)
└──────────────┘
       ↓
┌──────────────┐
│ Deepgram STT │  → Real-time streaming transcription (Nova-2 WebSocket)
└──────────────┘
       ↓
┌──────────────┐
│  JEV Engine  │  → Embeds utterance & matches next action (sub-ms)
└──────────────┘
       ↓
┌──────────────┐
│ Node Handler │  → Executes TypeScript action, DB query, or tool call
└──────────────┘
       ↓
┌──────────────┐
│ Deepgram TTS │  → High-speed streaming speech synthesis (Aura / ElevenLabs)
└──────────────┘
       ↓
Audio Out (PCM16)
```

---

## 🧠 Joint Embedding Vector (JEV) Engine

The **JEV Engine** is the core intelligence of Felona Voice:

1. **Action Space Embedding**: At initialization, every action node's descriptive prompt (e.g., *"Check delivery status, tracking number, and transit ETA"*) is encoded into a high-dimensional vector.
2. **Context Encoding**: When a user speaks, the conversation memory (user utterance weighted heavily, recent assistant turns summarized) is encoded into a context vector.
3. **Similarity Scoring**: Fast cosine similarity is computed against candidate actions.
4. **Fallback Guard**:
   - If the top candidate score is below `0.35`, the utterance is deemed out-of-scope and routed to `fallback`.
   - If the top score is below `0.55` and the margin between the first and second candidate is less than `0.15`, JEV routes safely to `fallback` (*"Sorry, I am not able to understand."*).

---

## ⚡ Pluggable Subsystems

Every subsystem in Felona Voice implements clean, modular TypeScript interfaces defined in `packages/core/src/types.ts`:

- **STT (Speech-to-Text)**: Pluggable `STTProvider` (Built-in: Deepgram streaming WebSocket).
- **TTS (Text-to-Speech)**: Pluggable `TTSProvider` (Built-in: Deepgram Aura, ElevenLabs HTTP streaming).
- **VAD (Voice Activity Detection)**: Built-in zero-dependency `EnergyVAD` with automatic silence thresholds.
- **Transport**: Pluggable `Transport` (Built-in: `WebSocketTransport` for bidirectional binary PCM audio, `WebRTCTransport` for browser/mobile clients, `TwilioTransport` for telephony).
- **Tools**: `ToolRegistry` for native tools, plus `McpClient` for tools borrowed from any MCP server over JSON-RPC.
- **Observability**: `FelonaTracer` emits OpenTelemetry spans for turns, routing decisions, handlers, tool calls and TTS. No-op until an application registers a tracer provider.
- **Embeddings**: Pluggable `EmbeddingProvider` (Built-in: `FastSemanticEmbeddingProvider` with zero configuration, or `OpenAIEmbeddingProvider`).
- **Memory**: `ConversationMemory` manages sliding-window conversation turns and key-value state slots.
