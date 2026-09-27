# 📖 Complete API Reference

Exhaustive documentation for every class, function, interface, and method in `felona-voice`.

---

## 1. `VoiceGraph<TState>` & `CompiledVoiceGraph<TState>`

Stateful conversational workflow and state machine with JEV neural routing.

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
  Executes a turn programmatically. Returns the matched action, confidence, candidate scores and timing.
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
  Built-in 128-dimensional deterministic embedding provider. **No external API key required.**
  Combines three independently normalized signals — keyword anchors (0.62), character 3-grams (0.23) and word hashes (0.15) — after stopword removal and suffix stemming, so routing does not degrade as utterances get longer.
- **`OpenAIEmbeddingProvider`**:
  Embeddings via OpenAI `text-embedding-3-small`.
- **`JEVEngine`**:
  Embeds every action description into the action space. Throws on duplicate or empty action IDs.
  `loadPredictor()` throws — trained predictors are not implemented in this release.
- **`cosineSimilarity(a: Float64Array, b: Float64Array): number`**:
  High-performance normalized cosine similarity calculation.
- **`EnergyVAD`**: Energy-based Voice Activity Detection for real-time speech start/end segmentation. Throws if `silenceThreshold >= speechThreshold` (which would latch speech on forever).
- **`ConversationMemory`**: Sliding-window turns buffer and slot storage.
- **`ToolRegistry` & `defineTool()`**: Tool calling execution layer for action handlers.
- **`pcmToWav(pcm, sampleRate, channels, bitDepth)`**: Generates valid 44-byte RIFF/WAVE headers for raw linear PCM audio data.

### `FelAgentConfig` reference

| Field | Type | Notes |
| :--- | :--- | :--- |
| `jev.embeddingProvider` | `string \| EmbeddingProvider` | `"fast-semantic"` (default), `"openai"`, or an instance. An unknown name throws. |
| `jev.embeddingApiKey` | `string` | Required when `embeddingProvider` is `"openai"`. |
| `jev.confidenceThreshold` | `number` | Below this, route to the `fallback` action. Default `0.35`. |
| `jev.predictorModel` | `string` | **Not implemented** — `listen()` throws if set. |
| `vad` | `{ speechThreshold?, silenceThreshold?, hangoverMs?, minSpeechMs? }` | Per-session VAD tuning. Validated on construction. |
| `sttFlushTimeoutMs` | `number` | How long to wait for a final transcript before submitting a turn. Default `1500`. Raise for slow/batch STT. |
| `sessions.maxConcurrent` | `number` | Hard cap enforced atomically at `createSession()`. |
| `sessions.store` | `SessionStore` | Providing one opts into persistence; omitting it keeps sessions ephemeral and in-memory. |
| `transport.authToken` | `string` | WebSocket clients must send `?token=` or `Authorization: Bearer`. |
| `transport.maxConnections` | `number` | Rejects upgrades beyond this many concurrent sessions. |
| `transport.allowedHosts` | `string[]` | Restricts the TwiML webhook to these `Host` values. |
| `transport.authTokenTwilio` + `transport.publicUrl` | `string` | Enables `X-Twilio-Signature` validation on the webhook. |
| `logging.logDir` | `string` | The only way call logs are written. Omit it and nothing touches disk. |

### Turn handling

| Option | Default | What it does |
| :--- | :--- | :--- |
| `endpointing.detection` | `auto` | `vad` uses energy hangover; `stt` defers to the recognizer's endpoint via `flush()`; `auto` prefers `stt` when available. |
| `endpointing.minDelayMs` | `800` | Silence required after the last speech frame. |
| `endpointing.maxDelayMs` | `3000` | Hard cap, so a stuck VAD cannot swallow a turn. |
| `endpointing.mode` | `fixed` | `dynamic` adapts the window to the speaker's observed pause distribution. |
| `interruption.mode` | `adaptive` | `immediate` stops on any speech; `adaptive` requires sustained speech (and optionally words) before treating it as a barge-in. |
| `interruption.minSpeechMs` | `500` | Sustained speech needed to interrupt. |
| `interruption.minWords` | `0` | Transcribed words needed to interrupt. Needs interim results. |
| `interruption.falseInterruptionTimeoutMs` | `2000` | Silence before an overlap is classified as noise. |
| `interruption.resumeOnFalseInterruption` | `true` | Resume playback from where it stopped instead of abandoning the utterance. |
| `preemptive.enabled` | `true` | Begin routing on the first final transcript, overlapping the endpointing wait. Cancelled if the transcript changes. |
| `preemptive.maxRetries` | `3` | Cap on speculative attempts per turn. |
| `audio.*` | on | DC block, high-pass (`highPassHz` 80), noise gate (0.06), AGC (target 0.06, max gain 8). |
| `dtmf.expectedDigits` | — | Digits that complete a keypad entry. On completion the digits are answered as a turn. |
| `language` | provider default | BCP-47 tag, or a list for auto-detection. |
| `knowledge` | — | `{ topK?, minScore?, chunk? }` for the agent's knowledge base. |
| `transfers` | — | Twilio Account SID + Auth Token. Enables `ctx.transfer()`; omit and it is `undefined` rather than a silent no-op. |
| `dtmf.terminateOn` | — | Digit that explicitly ends an entry, e.g. `"#"`. |

A false interruption emits `falseInterruption` and replays the remaining buffered audio — no re-synthesis, so resuming costs nothing.

### `STTStream` contract

| Member | Required | Purpose |
| :--- | :--- | :--- |
| `write(chunk)` | yes | Feed audio. Implementations may buffer until connected. |
| `onResult(handler)` | yes | Interim and final transcripts. |
| `close()` | yes | Tear down. Batch providers transcribe any remaining audio first. |
| `flush()` | optional | Resolve once buffered audio has been transcribed. Called by the pipeline at turn end so a turn is never submitted on a partial transcript. Implemented by every built-in provider. |
| `onError(handler)` | optional | Stream-level failures. Deliberately not an `error` event, which would be fatal on a bare `EventEmitter`. |

Whisper, Azure and Google have no streaming endpoint. They buffer audio and transcribe on `flush()`, which is what makes them usable on a live call instead of only at call end.

### Knowledge base

Retrieval over the agent's own documentation. It reuses the JEV embedding provider, so a custom provider improves both routing and retrieval without a second dependency.

```typescript
const agent = createAgent("Support")
  .knowledgeTask({
    id: "policy",
    answer: (results) =>
      results.length > 0
        ? results[0].text
        : "I don't have that information in front of me right now.",
  })
  .build();

await agent.knowledge.addAll([
  { id: "returns", text: "Returns are accepted within 30 days of delivery.", metadata: { topic: "returns" } },
  { id: "shipping", text: "Standard shipping takes three to five business days.", metadata: { topic: "shipping" } },
]);
```

**Retrieval only — the framework never composes an answer for you.** `answer` is required; it receives the passages and returns the text to speak. That keeps the reply exactly what you return, with no model in the loop.

| Option | Default | Notes |
| :--- | :--- | :--- |
| `topK` | 3 | Passages returned. |
| `minScore` | 0.2 | Similarity floor. **Without it, an unrelated query still returns the least-bad passage** and the agent answers from it confidently. |
| `chunk.targetChars` | 500 | Chunk boundaries decide retrieval quality more than the metric does. |
| `chunk.overlapChars` | 100 | Carries the tail of each chunk forward, so a fact straddling a boundary is retrievable from either side. |

Chunking is boundary-aware: paragraphs first, then sentences, then word wrap. Abbreviations (`Dr.`, `e.g.`) and decimals are protected. Re-adding a document **replaces** it, so an updated policy cannot leave a contradicting duplicate behind. Query embeddings are cached (bounded at 128 entries).

`ctx.knowledge.search(query)` is available to any handler, with `topK` / `minScore` / `filter` overrides.

### Call transfer

An agent that *says* it is escalating while doing nothing is worse than one that cannot escalate, so transfer is first-class.

```typescript
const agent = new FelAgent({
  actions: [
    defineAction({
      id: "escalate",
      description: "Escalate to a human supervisor",
      handler: async (ctx) => {
        if (!ctx.transfer) {
          return "This agent cannot transfer calls right now.";
        }
        // Warm: this text is spoken in full, then the line is redirected.
        ctx.transfer({
          mode: "warm",
          to: "+15551234567",
          message: "I'm transferring you to a senior support lead now.",
          context: { reason: "supervisor requested", orderId: "ACM-9281" },
        });
        return "Let me get a colleague for you.";
      },
    }),
  ],
  transfers: { accountSid: process.env.TWILIO_ACCOUNT_SID!, authToken: process.env.TWILIO_AUTH_TOKEN! },
});
```

| Mode | Behaviour |
| :--- | :--- |
| `cold` | Hand the call over immediately. |
| `warm` | The agent's reply is spoken **in full first**, then the call is redirected. |

`ctx.transfer()` is **staged, not immediate**: the transfer runs after the returned text finishes playing. Without that, "connecting you now" gets cut off mid-sentence. `context` becomes SIP parameters on the redirect.

`ctx.transfer` is `undefined` — not a no-op — when no transfer provider is configured, so handlers can distinguish "cannot transfer" from "transfer failed". Events: `transferring`, `transferred`, `transferFailed`.

### Supervision

```typescript
import { createCallSupervisor } from "felona-voice";

const sup = createCallSupervisor(sessionId, { transport, resolveSession });

sup.attach({ sessionId, state: "agent", onAudio: (c) => streamToSupervisor(c), speak: speakAsSupervisor });

sup.mute();                      // agent silent, still transcribing
await sup.speak("Let me help.");  // supervisor talks, then control returns
sup.takeover("customer angry");  // agent off the call entirely
sup.release();                   // back to the agent
sup.whisper("offer the refund"); // supervisor-only note
sup.end();
```

| State | Agent audio forwarded? | Meaning |
| :--- | :--- | :--- |
| `agent` | yes | Agent handles the call. |
| `supervisor` | no | Supervisor holds the floor. |
| `muted` | no | Agent silent but still transcribing, so the conversation survives a handoff. |
| `ended` | no | Call over. |

`speak()` returns control to the agent only if the agent had it — an explicit `takeover()` is not silently undone, so a supervisor who took the call doesn't get dropped mid-conversation. The controller never buffers call audio itself, preserving the framework's no-persistence default.

### Scenario testing

A voice agent's behaviour is a function of the *caller*, so ordinary unit tests cannot cover it. Scenarios drive an agent through scripted conversations and assert on what it did.

```typescript
// scenarios.ts
import { createAgent, type Scenario } from "felona-voice";

export const agent = createAgent("Acme Support")
  .action("order_status", "Check delivery status for an order", "Your order is out for delivery today.")
  .fallback("Sorry, I did not catch that.")
  .build();

export const scenarios: Scenario[] = [
  {
    name: "routes an order question",
    turns: [
      {
        say: "where is my order",
        expect: {
          action: "order_status",
          responseContains: ["out for delivery"],
          confidence: { above: 0.3 },
          latencyUnderMs: 250,
        },
      },
    ],
  },
];
```

```bash
npx felona test ./scenarios.ts --verbose
```

Exits non-zero on failure, so it drops straight into CI. Each `ScenarioTurn` supports `expect` (action, response contents/pattern/exclusions, confidence bounds, slots, latency budget) and an `assert` escape hatch. Scenarios are isolated by default — each gets a fresh session, because a scenario that inherits the previous one's memory is order-dependent and will flake.

This matters most for JEV routing: changing an action description or the embedding provider silently re-routes every agent built on it, and no type system notices.

### Languages

| Config | Behaviour |
| :--- | :--- |
| `language: "es-ES"` | Forwarded to the STT provider verbatim. |
| `language: ["en-US", "es-ES"]` | Passed as `multi` so the recognizer auto-detects; `detectLanguage()` can break ties from markers. |
| omitted | The provider's own default applies. |

Previously the pipeline hardcoded `en-US`, so a non-English agent silently transcribed against the wrong model. `describeLanguage()` renders the resolved policy for logs.

### Slot extraction

Typed slot collection for the values a call centre actually needs. Extractors parse **spoken** input, not typed text: `"jane dot doe at gmail dot com"` → `jane.doe@gmail.com`, `"triple five"` → `555`, `"four five three nine five seven eight seven six three six two one four eight six"` → a valid card number.

| Type | Notes |
| :--- | :--- |
| `name` | Conservative — only fires on an explicit introduction, so it cannot capture half a sentence. |
| `email` | Handles spoken `at` / `dot` / `underscore`. |
| `phone` | Spoken digits, formatted numbers, NANP validation. |
| `address` | Requires a number and a street type; preserves the caller's casing. |
| `zip`, `number`, `date` | Spoken and literal forms. |
| `cardNumber` | Luhn-checked, which catches the single misheard digit that is the usual failure. |
| `expiry`, `cvv` | Month names and years, spoken or numeric. |

```typescript
import { createAgent, continueCollectTask, getTaskCollector } from "felona-voice";

const agent = createAgent("Checkout")
  .collect({
    id: "take_details",
    slots: [
      { name: "name", type: "name" },
      { name: "email", type: "email" },
      { name: "cardNumber", type: "cardNumber" },
    ],
    onComplete: (s) => `Thanks ${s.name}, order confirmed.`,
  })
  .build();
```

Ready-made tasks: `getNameTask`, `getEmailTask`, `getPhoneNumberTask`, `getAddressTask`, `getDateOfBirthTask`, `getZipCodeTask`, `getCreditCardTask`. Collectors live on the session's in-memory slots, so state survives across turns and is never written to disk. Use `shouldAttempt` on a slot definition when one type could otherwise swallow another's input (a 5-digit order number reads as a ZIP).

---

## 8. Call Analytics (`packages/core/src/analytics/`)

Post-call scoring. Everything here is a pure function over the turns you already have, so it can run in tests, in a batch job, or offline against `CallLogEntry` files written by `createCallLogger`.

| Function | Returns |
| :--- | :--- |
| `analyzeCall(session, turns, decisions, options?): CallAnalysis` | Overall verdict for the call. |
| `analyzeSentiment(turns): SentimentScore` | Polarity of the caller across the call. |
| `analyzeConfidence(decisions, threshold, turnCount): ConfidenceProfile` | Per-action certainty. |

`decisions` is the JEV decision log — `Array<{ confidence: number; selectedAction: string }>`, the same shape `CallLogger` writes. Pass the same array you gave the pipeline, or `analyzeConfidence` will grade an empty action space as `weak`.

```typescript
import { analyzeCall } from "felona-voice";

const analysis = analyzeCall(session, turns, decisions, {
  successActions: ["order_confirmed", "refund_issued"],
  resolve: (t) => t.at(-1)?.content.includes("all set"), // optional ground truth
});

analysis.resolved;         // did the caller leave with an answer?
analysis.resolutionSource; // "explicit" | "action" | "heuristic"
```

### `CallAnalysis`

| Field | Notes |
| :--- | :--- |
| `outcomeScore` | 0–100 blend of sentiment, confidence, and escalation risk. A blunt rollup for dashboards; the fields below it explain it. |
| `summary` | One-line human-readable verdict. |
| `sentiment` | `SentimentScore` from `analyzeSentiment`. |
| `escalationRisk` | Set when the caller asks for a manager or frustration signals appeared. |
| `unresolved` | The caller was still asking for something at the end. |
| `resolved` | The inverse: the request was addressed. |
| `resolutionSource` | Which of the three signals decided `resolved` — useful when it disagrees with `summary`. |
| `actionBreakdown` | Actions used, most frequent first. |

`resolved` is decided by strict precedence, which is worth knowing when it surprises you:

1. **`explicit`** — `options.resolve(turns)` returned a boolean. A real outcome from your own code always beats inference.
2. **`action`** — one of `options.successActions` was hit.
3. **`heuristic`** — nothing explicit was configured, so it falls back to `!unresolved && !escalationRisk`.

This is why a call can be `resolved: true` while `escalationRisk` is set: your `resolve` hook said the refund went through, and that wins. Read `resolutionSource` to tell that case apart from a clean heuristic pass.

| `escalationActions` | Action ids that count as an escalation, in addition to the phrase heuristics. |

Omitting `resolve` means the heuristic decides on its own, which is right for exploration and wrong for billing — a `successActions` list is the cheapest way to make it honest.

### Configuring what counts as a good call

Left alone, a pipeline analyses the call from the transcript alone. To let it know what actually happened, pass `AnalyzeOptions` on the agent — the same options the function takes:

```typescript
const agent = createAgent("Support")
  .analysis({
    successActions: ["order_confirmed", "refund_issued"],
    escalationActions: ["transfer_human"],
    resolve: (turns) => tickets.isClosed(turns),   // optional ground truth
  })
  .build();
```

The result is available as `pipeline.callAnalysis`, and the pipeline emits a `callAnalysis` event when the call ends:

```typescript
pipeline.on("callAnalysis", (analysis) => {
  metrics.gauge("calls.resolved", analysis.resolved ? 1 : 0);
});
```

One thing to know about the numbers: the caller's words are **not** written to the call log or the analysis. `resolve` runs on the turns in memory, so if your hook needs the content, it has to use it there and not return it.

---

## 9. MCP Tool Support (`packages/core/src/tools/mcp.ts`)

Borrow tools from any [MCP](https://modelcontextprotocol.io) server and use them like native ones. Implemented directly over JSON-RPC 2.0, with no SDK dependency — the whole surface is `tools/list` and `tools/call`, and a framework you self-host should not force a transport stack on you.

```typescript
import { createAgent, createMcpClient } from "felona-voice";

const weather = createMcpClient({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-weather"],
  env: { OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY },
  namePrefix: "wx_",          // avoids collisions with other servers
  requestTimeoutMs: 10_000,
});

const agent = await createAgent("Support")
  .action("check_weather", "Check the weather", async (ctx) => {
    const result = await ctx.tools.call("wx_get_weather", { city: "Leeds" });
    return `It is currently ${result.summary}.`;
  })
  .mcp(weather)
  .connectMcp();               // note: connectMcp, not build
```

> `build()` is synchronous and listing an MCP server is not — the server is a
> subprocess that has to be asked over a pipe. Use `connectMcp()` when `.mcp()`
> was used; plain `build()` is fine when it was not.

| Function | Purpose |
| :--- | :--- |
| `createMcpClient(options)` | Client already wired to a spawned stdio server. |
| `client.connect()` | Start the transport and perform the handshake. Idempotent. |
| `client.list()` | The server's tools as `AgentTool[]`. |
| `client.listToolNames()` | Just the names, without building descriptors. |
| `client.call(name, params)` | Call a tool; returns the server's `content` shape. |
| `client.callText(name, params)` | Call a tool and return only its text. |
| `client.asTools()` | Tools without registering them anywhere. |
| `client.registerInto(registry)` | Bridge into a `ToolRegistry`. |
| `collectMcpTools(clients)` | Flatten several servers, rejecting name collisions. |
| `extractMcpText(result)` | Text blocks out of an MCP result. |

### Options

| Option | Default | Notes |
| :--- | :--- | :--- |
| `command` / `args` / `cwd` / `env` | — | The server to spawn. `env` is merged over the inherited environment. |
| `stderr` | `"forward"` | `forward` logs each line prefixed with the server name, `inherit` writes to your stderr, `ignore` discards. The stream is always drained — an unread pipe fills and blocks the server. |
| `namePrefix` | — | Prefixed to every tool name. Stripped again when calling, so the server still sees its own names. |
| `requestTimeoutMs` | `30000` | A wedged server must fail the call, not hang it. `0` disables. |
| `protocolVersion` | `2025-06-18` | A server answering with a revision this client does not support is rejected rather than tolerated. |
| `describeTool` | — | Rewrite descriptions for a voice model. MCP descriptions are often written for text ("Returns the current weather as JSON") and read badly aloud. |

### Behaviour worth knowing

- **The connection is lazy.** Nothing spawns until the first `connect()` or tool call, so declaring a server that is not running costs nothing.
- **A tool that fails throws.** A result with `isError` is raised as an exception, so a failure is never read aloud as if it were an answer.
- **A missing tool name throws.** Names are validated against `[A-Za-z0-9_.-]{1,128}` before they reach the LLM, so a hostile server cannot inject a name that breaks function calling.
- **Dropping the connection fails in-flight calls** rather than leaving them to time out.
- **Non-JSON output on stdout is skipped, not fatal.** A server that logs to stdout will not take the call down; the missing response surfaces as a timeout on the request waiting for it.

For an in-process or socket-based server, implement `McpTransport` and pass it to `new McpClient(transport, options)` — that is also how the tests drive the client without a subprocess.

---

## 10. OpenTelemetry Tracing (`packages/core/src/observability/`)

Built on the OpenTelemetry **API** only, which contains no SDK. When your application has not registered a tracer provider, every call here resolves to a no-op and costs a function call. Install an SDK and exporter, and spans start appearing with no change to Felona's configuration.

```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

```typescript
// Register the SDK before importing felona-voice.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();
```

### Spans

| Span | Emitted around |
| :--- | :--- |
| `felona.turn` | One caller turn: transcript in, audio out. |
| `felona.jev.decide` | JEV predicting the next action, with the choice and its confidence. |
| `felona.action.handle` | An action handler producing its reply. |
| `felona.tts.speak` | Synthesis and playback, including time to first audio. |
| `felona.tool.call` | A tool invoked by a handler. |
| `felona.transfer` | Handing the call to a human. |
| `felona.call.end` | The call ending. |

They nest: a turn contains the routing decision, which contains the action handler, which contains any tool call. That is what makes a slow reply explainable — a slow JEV prediction and a slow tool lookup look identical from the caller's side and are not from the trace.

```typescript
import { createFelonaTracer, SPAN, contentFingerprint } from "felona-voice";

const tracer = createFelonaTracer({ name: "my-voice-agent" });

// Inside a handler, so a call out to another service joins this trace:
const headers = tracer.injectContext({});
```

### What is never recorded

**Transcript text is never written to a span attribute.** Spans are exported and stored by whatever backend you chose, usually for far longer than the call. Turns are identified by `felona.turn.fingerprint` — a short SHA-256 prefix that still lets you group identical turns — plus a character count. Tool calls record `felona.tool.arg_keys`, the *names* of the arguments, never their values, because a tool argument is very often something the caller just said out loud.

If you need the content in a trace, log it deliberately in your own hook, where you control retention.

### Injecting a tracer

`FelAgentConfig.tracer` and the `VoicePipeline` constructor both accept a `FelonaTracer`, so you can control the instrumentation scope or assert on spans in a test:

```typescript
const agent = createAgent("Support").tracer(myTracer).build();
```

The agent passes one tracer to both the pipeline and its tool registry, so tool calls share the trace of the turn that triggered them.

---

## 11. WebRTC Transport (`packages/core/src/transport/webrtc.ts`)

Browser-to-agent audio over WebRTC, for when the client is a browser or a mobile app rather than a server.

WebSocket remains the default and the right choice for server-to-server media. WebRTC earns its place for a browser because the media path is already encrypted and already handles NAT traversal: no TURN bill, no TLS termination for the media, and the browser supplies echo cancellation and jitter buffering.

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("Browser Assistant")
  .transport({
    type: "webrtc",
    port: 8080,
    authToken: process.env.SIGNALLING_TOKEN,   // required for anything reachable
  })
  .build();
```

### Signalling

WebRTC needs a signalling channel, and it cannot be the media path itself, so the transport serves a small HTTP endpoint:

| Endpoint | Body | Response |
| :--- | :--- | :--- |
| `POST /offer` | `{ sdp, type? }` | `200 { sessionId, answer }` |
| `POST /offer/ice` | `{ sessionId, candidate }` | `204` |

The client POSTs its offer and gets an answer plus the session id it is known by from then on. Trickling on `/offer/ice` is optional: by default the transport waits up to `waitForIceGatheringMs` (3000) for candidates so the answer is self-sufficient and a client only has to make one request. Set it to `0` to answer immediately and rely on trickle instead.

### Audio format

**PCMU (G.711 μ-law) at 8 kHz, carried as RTP, in both directions.** The answer deliberately offers PCMU and nothing else, because the inbound path decodes G.711 and no other codec — an answer that also advertised Opus would let a client choose Opus for its own send direction and the agent would silently hear nothing.

PCMU is chosen over Opus for a reason specific to this framework: it is the one codec where the wire format is a pure function of the sample, so the same G.711 code the telephony path already uses converts in both directions with no encoder state, no lookahead and no per-stream priming. A deployment running both transports converts audio only once. Speech at 8 kHz is intelligible; the quality cost against Opus is real and worth weighing if you are narrating rather than transacting.

| Option | Default | Notes |
| :--- | :--- | :--- |
| `authToken` | — | Required in practice. The media is DTLS-SRTP encrypted, but the signalling endpoint is plain HTTP and will hand an attacker a peer connection if left open. Compared in constant time. |
| `verifyClient` | — | Takes precedence over `authToken`. A throw is treated as a rejection. |
| `path` | `/offer` | Where signalling is served. |
| `maxConnections` | Infinity | Excess callers get a `503` rather than a peer that is then starved. |
| `waitForIceGatheringMs` | `3000` | See above. `0` answers immediately. |
| `direction` | `sendrecv` | Only lower this for a genuinely one-way agent — `recvonly` leaves the reply with no track to send on. |
| `peerConfig` | — | Passed to the peer connection factory. |
| `createPeerConnection` / `createAudioTrack` | bundled stack | Inject these together to use a different WebRTC implementation. |

### Behaviour worth knowing

- **Audio is transcoded and packetized to whole 20 ms frames.** A chunk shorter than a frame is held until the rest arrives, because a short frame reads as packet loss to the receiver's jitter buffer.
- **`clearAudio()` drops queued audio** — the WebRTC equivalent of barge-in, so the agent stops talking over the caller.
- **A dead peer ends the call.** WebRTC has no close frame, so a caller navigating away is only visible as a connection-state change; without handling it the session would linger and hold a slot.
- **There is no data channel**, so `sendMessage()` throws rather than appearing to work. Use the WebSocket transport if you need a control channel.
- **`stop()` only closes a server it opened.** Pass your own via `TransportOptions.server` to share a port, and it is left alone.

The peer connection factory and audio track factory are separate because a transceiver added *by kind* leaves the sender with no track, and the only track then reachable is the receiver's — which is remote and rejects writes.
