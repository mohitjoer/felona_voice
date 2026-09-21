# 🏗️ Architecture & Core Principles

Felona Voice is designed from the ground up for **ultra-low-latency, real-time voice interactions**.

Unlike traditional conversational AI frameworks that rely on large language models (LLMs) to decide both *what* to do and *how* to respond, Felona Voice decouples conversational intent from generative text.

---

## 🚫 Why 100% LLM-Free?

In voice applications, **latency is everything**. Humans perceive conversational gaps larger than 200–300 milliseconds as awkward or unresponsive.

| Dimension | LLM-Centric Voice Agents | Felona Voice (JEV Engine) |
| :--- | :--- | :--- |
| **Decision Latency** | 400ms – 1,200ms per turn | **~5ms** (Cosine Semantic Space) |
| **Cost** | Expensive input/output token pricing | **$0.00** runtime model inference |
| **Predictability** | Prone to hallucinations and prompt injection | **100% Deterministic** node execution |
| **Dependencies** | Requires external LLM API keys | **Zero external dependencies** (local embeddings) |
| **Debugging** | Hard to trace prompt logic | Clear state graph transitions & candidate scores |

**In Felona Voice, JEV decides what action/node to take in ~5ms. The action handler executes clean TypeScript code and returns the exact speech string to TTS immediately.**

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
│  JEV Engine  │  → Embeds utterance & matches next action in ~5ms
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
- **Transport**: Pluggable `Transport` (Built-in: `WebSocketTransport` for bidirectional binary PCM audio).
- **Embeddings**: Pluggable `EmbeddingProvider` (Built-in: `FastSemanticEmbeddingProvider` with zero configuration, or `OpenAIEmbeddingProvider`).
- **Memory**: `ConversationMemory` manages sliding-window conversation turns and key-value state slots.
