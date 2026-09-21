# 📖 Complete API Reference

Exhaustive documentation for every class, function, interface, and method in `felona-voice`.

---

## 1. `VoiceGraph<TState>` & `CompiledVoiceGraph<TState>`

LangGraph-inspired conversational state machine with JEV neural routing.

### `new VoiceGraph<TState>()`
Creates a new uncompiled voice graph builder.

#### Methods on `VoiceGraph`:
- **`setState(initialState: TState): this`**
  Sets the default initial state channels.
- **`addNode(id: string, options: NodeOptions<TState> | string): this`**
  Adds a conversational node with an action description and execution handler.
- **`addEdge(from: string, to: string): this`**
  Adds a directed edge between two nodes, constraining the allowed next states.
- **`addEdges(from: string, toList: string[]): this`**
  Adds multiple transition edges from a source node.
- **`setEntryPoint(nodeId: string): this`**
  Defines the starting node for the graph.
- **`setThreshold(threshold: number): this`**
  Sets the minimum JEV cosine similarity threshold (default: `0.35`).
- **`setEmbeddingProvider(provider: EmbeddingProvider): this`**
  Sets custom embedding provider (defaults to `FastSemanticEmbeddingProvider`).
- **`compile(): Promise<CompiledVoiceGraph<TState>>`**
  Compiles the graph and initializes the JEV Action Space.
- **`drawMarkdown(options?: { title?: string }): string`**
  Generates full Markdown documentation with native Mermaid diagrams and transition tables.
- **`drawAscii(options?: { title?: string }): string`**
  Renders terminal ASCII box diagram.
- **`drawMermaid(): string`**
  Generates Mermaid flowchart TD string.
- **`toMermaidLiveUrl(): string`**
  Generates a direct Mermaid Live Editor link.
- **`visualize(options?: VisualizeOptions): Promise<VisualizeResult>`**
  Visualizes the graph in Markdown, ASCII, Mermaid, or interactive HTML.

---

### `CompiledVoiceGraph<TState>`
The compiled, runnable voice state machine.

#### Methods on `CompiledVoiceGraph`:
- **`invoke(input: string | GraphInvokeInput<TState>): Promise<GraphInvokeOutput<TState>>`**
  Executes a single conversational turn through the state machine:
  - Embeds utterance and matches next node using JEV.
  - Constrains matching to allowed edges from the current node.
  - Executes node handler and updates state.
- **`simulate(messages: string[], initialState?: Partial<TState>): Promise<Array<GraphInvokeOutput<TState>>>`**
  Simulates a multi-turn conversation sequentially.
- **`toAgent(options?: { name?: string; sttApiKey?: string; ttsApiKey?: string }): FelAgent`**
  Converts the compiled graph into a full `FelAgent` ready for streaming WebSocket voice calls.
- **`drawMarkdown()`, `drawAscii()`, `drawMermaid()`, `toMermaidLiveUrl()`, `visualize()`**
  Same visualization suite as uncompiled graph.

---

## 2. Fluent Agent Builder (`createAgent`, `AgentBuilder`)

Zero-boilerplate fluent API for creating and configuring agents.

### `createAgent(name?: string): AgentBuilder`
Returns a new fluent `AgentBuilder`.

#### Methods on `AgentBuilder`:
- **`name(name: string): this`**: Sets the agent's display name.
- **`system(prompt: string): this`**: Sets personality prompt.
- **`slot(key: string, value: unknown): this`**: Adds an initial memory slot.
- **`slotsRecord(slots: Record<string, unknown>): this`**: Adds multiple initial slots.
- **`action(id: string, description: string, handler: string | ActionHandlerFn): this`**:
  Adds an action node to the agent.
- **`fallback(responseOrHandler?: string | ActionHandlerFn): this`**:
  Defines the out-of-scope fallback response (defaults to *"Sorry, I am not able to understand."*).
- **`deepgram(options: { apiKey: string; ttsVoice?: string }): this`**:
  Configures Deepgram STT (Nova-2) and optional Deepgram TTS (Aura).
- **`elevenlabs(options: { apiKey: string; voice?: string }): this`**:
  Configures ElevenLabs TTS.
- **`embedding(provider: EmbeddingProvider): this`**:
  Configures custom embedding provider.
- **`threshold(threshold: number): this`**:
  Sets confidence threshold (default: `0.35`).
- **`build(): FelAgent`**:
  Instantiates and returns the configured `FelAgent`.
- **`interact(input: string | InteractOptions): Promise<InteractResult>`**:
  Simulates a single conversational turn without needing to call `.build()`.
- **`drawMarkdown()`, `drawAscii()`, `drawMermaid()`, `visualize()`**:
  Generates documentation directly from the builder.

---

### Pre-Built Agent Templates
- **`createSupportAgent(options?: { companyName?: string; orderLookup?: ...; slots?: ...; deepgramApiKey?: ...; embeddingProvider?: ... }): AgentBuilder`**
  Ready-to-use Tier-1 Customer Support agent with greeting, order status tracking, troubleshooting, refunds, and manager escalation.
- **`createSalesAgent(options?: { companyName?: string; repName?: string; ... }): AgentBuilder`**
  Outbound sales qualification agent with elevator pitch, pricing objections, and demo booking.

---

## 3. `FelAgent`

The main runtime class for running voice agents over WebSocket audio.

### `new FelAgent(config: FelAgentConfig)`

#### Methods on `FelAgent`:
- **`interact(input: string | InteractOptions): Promise<InteractResult>`**
  Executes a turn programmatically in ~5ms.
- **`listen(options?: { port?: number; host?: string }): Promise<void>`**
  Starts the WebSocket server (default port: 8080) for streaming PCM audio.
- **`stop(): Promise<void>`**
  Stops the WebSocket server and active audio pipelines.
- **`drawMarkdown()`, `drawAscii()`, `drawMermaid()`, `toMermaidLiveUrl()`, `visualize()`**
  Visualizer tools for the agent's action space.

---

## 4. Visualization Functions (`packages/core/src/graph/visualize.ts`)

Standalone utilities for inspecting and documenting graphs.

- **`drawMarkdown(target, options?: { title?: string }): string`**
  Generates Markdown documentation with Mermaid diagrams, transition tables, node catalog, and ASCII flow.
- **`drawAscii(target, options?: { title?: string }): string`**
  Renders terminal Unicode box diagram.
- **`drawMermaid(target): string`**
  Returns Mermaid flowchart syntax.
- **`toMermaidLiveUrl(target): string`**
  Returns direct URL to Mermaid Live Editor.
- **`generateGraphHtml(target, options?: { title?: string }): string`**
  Generates interactive standalone single-file HTML viewer.
- **`visualizeGraph(target, options?: VisualizeOptions): Promise<VisualizeResult>`**
  Saves Markdown (`.md`), HTML (`.html`), or prints ASCII to console.

---

---

## 5. STT (Speech-to-Text) Providers

All STT providers implement the `STTProvider` interface:

```typescript
export interface STTProvider {
  readonly name: string;
  createStream(options?: STTStreamOptions): STTStream;
}
```

| Provider | Class | Factory | Description |
| :--- | :--- | :--- | :--- |
| **Deepgram** | `DeepgramSTT` | `createDeepgramSTT(opts)` | Real-time streaming WebSocket transcription with Nova-2 (<300ms). |
| **OpenAI Whisper** | `WhisperSTT` | `createWhisperSTT(opts)` | Audio transcription via OpenAI's `whisper-1` model with automatic WAV conversion. |
| **AssemblyAI** | `AssemblyAISTT` | `createAssemblyAISTT(opts)` | Real-time WebSocket streaming transcription with word boost. |
| **Azure Speech** | `AzureSTT` | `createAzureSTT(opts)` | Microsoft Cognitive Services Speech-to-Text with multi-language support. |
| **Google Cloud** | `GoogleSTT` | `createGoogleSTT(opts)` | Google Cloud Speech-to-Text v1 with word timestamps. |

---

## 6. TTS (Text-to-Speech) Providers

All TTS providers implement the `TTSProvider` interface:

```typescript
export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, options?: TTSOptions): AsyncIterable<AudioChunk>;
}
```

| Provider | Class | Factory | Description |
| :--- | :--- | :--- | :--- |
| **Cartesia** | `CartesiaTTS` | `createCartesiaTTS(opts)` | Ultra-low latency voice synthesis (<100ms TTFB) with Sonic English. |
| **Deepgram Aura** | `DeepgramTTS` | `createDeepgramTTS(opts)` | Fast conversational voice synthesis (`aura-asteria-en`, `aura-orpheus-en`). |
| **ElevenLabs** | `ElevenLabsTTS` | `createElevenLabsTTS(opts)` | Expressive voice generation (`eleven_turbo_v2_5`). |
| **OpenAI** | `OpenAITTS` | `createOpenAITTS(opts)` | OpenAI Audio Speech streaming raw 24kHz PCM (`alloy`, `nova`, `echo`). |
| **Azure Speech** | `AzureTTS` | `createAzureTTS(opts)` | Neural SSML voices from Microsoft Cognitive Services. |
| **Amazon Polly** | `PollyTTS` | `createPollyTTS(opts)` | AWS Polly Neural speech synthesis (`Joanna`, `Matthew`). |
| **LMNT** | `LMNTTTS` | `createLMNTTTS(opts)` | Conversational low-latency speech stream (`lily`, `curtis`). |

---

## 7. JEV Engine, Memory & VAD

- **`FastSemanticEmbeddingProvider`**:
  Built-in 128-dimensional deterministic semantic embedding engine. **Zero external API keys required**.
- **`OpenAIEmbeddingProvider`**:
  Embeddings via OpenAI `text-embedding-3-small`.
- **`JEVEngine`**:
  Initializes action spaces and predicts next nodes via cosine vector scoring in ~5ms.
- **`cosineSimilarity(a: Float64Array, b: Float64Array): number`**:
  High-performance normalized cosine similarity calculation.
- **`EnergyVAD`**: Energy-based Voice Activity Detection for real-time speech start/end segmentation.
- **`ConversationMemory`**: Sliding-window turns buffer and slot storage.
- **`ToolRegistry` & `defineTool()`**: Tool calling execution layer for action handlers.
- **`pcmToWav(pcm, sampleRate, channels, bitDepth)`**: Generates valid 44-byte RIFF/WAVE headers for raw linear PCM audio data.
