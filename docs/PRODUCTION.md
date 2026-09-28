# 🏭 Production Guide

What you need to run Felona Voice against real traffic: what is enforced by
default, what you must configure, and which knobs exist for each failure mode.

---

## 1. What is enforced by default

You do not have to opt into these; they are on unless noted.

| Behaviour | Default | Why |
|---|---|---|
| Concurrent call ceiling | `maxConcurrent: 100` per agent | A call holds a pipeline, VAD, preprocessor, STT socket and memory. Unbounded accepts as many calls as the network offers. Override with `sessions({ maxConcurrent })` to your real capacity. |
| WebSocket connection ceiling | none set | Set `maxConnections`, or there is no admission control on that transport. |
| Max call duration | 30 minutes | A half-open socket that never sends a close would otherwise hold resources for the life of the process. `maxCallDurationMs: 0` disables. |
| Outbound request deadline | 15s (20s for LLM) | An unbounded `fetch` holds a pipeline turn open forever, and turns serialise behind one flag — one hung request wedges the call. |
| Retry on transient failure | 3 attempts, exponential backoff, jitter | Applied to connection establishment and idempotent reads. **Never** applied mid-stream, once audio is flowing. |
| Batch-STT audio buffer | ~60s | A turn that never ends must not grow a buffer for the length of the call. Oldest audio is dropped, and the drop is reported. |
| Turn disk logging | **off** | Nothing is written anywhere unless you supply `logging.logDir`. |
| MCP child environment | PATH/HOME/TMPDIR only | An MCP server does not inherit your provider API keys. Opt in per server with `inheritEnv: true`. |
| TTS body on barge-in | aborted | Releasing the read lock does not close the socket; the request is cancelled so the vendor stops sending. |
| Card-shaped DTMF in logs | masked | A DTMF entry is how a card number reaches the agent. The log line keeps only the last four digits. |

### Not enforced — you should add these yourself

- **Rate limiting.** A single caller cannot pile up work (turns collapse to one
  pending turn rather than queueing), and `maxConnections`/`maxConcurrent`
  cap how many calls exist. Frequency limits across many connections belong at
  the edge — nginx, Cloudflare, or your carrier — not in the framework. If you
  need one in-process, a [guardrail](#4-guardrails) is a five-line hook that
  runs before every turn.
- **Compliance announcements, consent capture, DNC handling, recording.** These
  are legal obligations specific to your jurisdiction and campaign. The
  framework has no opinion about them and will not guess.
- **Load testing against your providers.** `npm run loadtest` measures the
  framework's own work with stubbed STT/TTS. Real-provider capacity is yours to
  measure — see [Measured capacity](#measured-capacity).

---

## 2. Observability

### Metrics

Every transport serves `/metrics` in Prometheus text format, and `/health`
returns live call counts.

```typescript
new FelAgent({
  // ...
  maxCallDurationMs: 20 * 60 * 1000,
});

// GET /health  -> {"status":"ok","provider":"twilio","activeCalls":3,...}
// GET /metrics -> text/plain; version=0.0.4
```

`/health` returns **503** once the transport is at `maxConnections`, so a load
balancer stops sending traffic rather than queueing calls the process cannot
serve. Set `exposeHealth: false` if live call volume should not be reachable.

| Metric | Meaning |
|---|---|
| `felona_calls_started_total` / `_ended_total` | Call lifecycle |
| `felona_calls_active` | Live calls (gauge) |
| `felona_calls_rejected_total` | Refused at capacity |
| `felona_calls_timed_out_total` | Ended by the duration limit |
| `felona_turns_total` / `_errors_total` | Turn outcomes |
| `felona_turns_abandoned_total` | Dropped because the caller interrupted |
| `felona_stt_errors_total` / `felona_tts_errors_total` | By provider label |
| `felona_barge_ins_total` | Caller interruptions |
| `felona_guardrail_blocks_total` | By `side: input\|output` |
| `felona_llm_prompt_tokens_total` / `_completion_tokens_total` | Model spend |
| `felona_call_cost_usd_total` | Estimated across all calls |
| `felona_voicemail_detected_total` | Calls ended by answering-machine detection |

### Logging

```typescript
logging: { format: "json" }   // one object per line, for a log shipper
logging: { format: "text" }   // default; readable in a terminal
```

JSON mode emits `{ time, level, component, msg, ...fields }` and routes by
severity, so errors and warnings reach shippers that read stderr. Startup
banners from transports stay human-readable in both modes.

Call transcripts are **not** written to logs. Turn content is fingerprinted
(SHA-256) in traces, and the decision log records a fingerprint rather than the
caller's words.

### Tracing

OpenTelemetry spans are emitted through the OTel **API** only — no SDK is
bundled, so nothing is exported until you register a provider. Spans cover the
turn, the JEV decision, the action handler, and TTS-plus-playback together
(time to first audio is the number that matters for a call).

---

## 3. Cost tracking

Per-call cost requires prices; the framework ships none, because a stale price
silently misreports spend.

```typescript
new FelAgent({
  cost: {
    prices: {
      llmPromptPerMTok: 0.25,
      llmCompletionPerMTok: 2.5,
      sttPerMinute: 0.008,
      ttsPer1kChars: 0.002,
    },
    onCallCost: (sessionId, cost) => billing.record(sessionId, cost),
  },
});

agent.on("callCost", ({ sessionId, cost }) => {
  // Fired once with the final figure when the call ends.
});
```

Audio seconds are derived from actual bytes, and TTS is priced from characters
synthesised. LLM tokens are reported by the handler — a handler that calls a
model must call `ctx.reportUsage({ promptTokens, completionTokens })`, or the
largest cost driver goes unmeasured. `builder.llm()` does this for you.

---

## 4. Guardrails

Two boundaries, both explicit. Nothing is blocked unless you configure a
guardrail.

```typescript
import { blockPattern, maxLength, runGuardrails } from "felona-voice";

new FelAgent({
  guardrails: {
    input: [
      // Blocks the prompt-injection path: caller speech reaches routing,
      // retrieval and tool arguments uninspected without this.
      blockPattern(/ignore (all )?(previous )?instructions/i, "prompt injection"),
      maxLength(500, "runaway input"),
    ],
    output: [
      ({ actionId }) =>
        actionId === "refund" && !verified.get(actionId)
          ? { action: "block", reason: "unverified", speak: "Let me check that first." }
          : { action: "allow" },
    ],
    onInputBlocked: "I'm sorry, I can't help with that.",
  },
});
```

- **Input** guardrails run after the transcript is final and before anything
  routes, retrieves, or calls a tool.
- **Output** guardrails run after the turn is committed and before a single word
  is spoken. The committed history stays accurate; only the spoken text changes.
- A guardrail that **throws blocks the turn**. A content filter that crashes
  silently is worse than no filter. The failure is logged so it is not mistaken
  for policy.

Because input guardrails run before every turn, they are also the right place
for a turn-rate limit.

---

## 5. Scaling out

### Sessions must be authoritative, not a mirror

`ConversationMemory` is in-process. For a call to resume on another node, the
turns have to be read back from the store — which the pipeline now does on
start, so an implement a `SessionStore` and pass it:

```typescript
import type { SessionStore, SessionRecord } from "felona-voice";

class RedisSessionStore implements SessionStore {
  async get(id: string): Promise<SessionRecord | null> { /* ... */ }
  async set(id: string, record: SessionRecord): Promise<void> { /* ... */ }
  // delete, touch, list, clear
}

new FelAgent({ sessions: { store: new RedisSessionStore(), maxConcurrent: 100 } });
```

Without this, a `SessionStore` is a write-only analytics copy: it holds the
turns, but nothing reads them back, and a call landing on a different node
resumes with an empty conversation.

### What still requires affinity

- **Live audio sockets.** A transport holds `RTCPeerConnection` and
  `MediaStreamTrack` objects that cannot be shared. Route by connection
  affinity behind your load balancer.
- **A process restart mid-call is unrecoverable**, whatever the store says.
  `maxCallDurationMs` bounds the damage.

### Measured capacity

`npm run loadtest [calls] [turns]` drives N concurrent calls through real
pipelines — EnergyVAD, preprocessing, JEV routing, the turn loop, TTS playback
— with stubbed STT/TTS. On the development machine:

| Concurrent calls | Turns | Throughput | Heap per call |
|---|---|---|---|
| 100 | 400 | ~9,400 turns/s | 10–64 KB |
| 500 | 1,500 | ~14,000 turns/s | ~36 KB |
| 2,000 | 6,000 | ~15,200 turns/s | ~18 KB |

Throughput does not degrade and per-call memory plateaus around 30 KB, so the
framework's own CPU work is **not** the binding constraint. What will stop you
first is external:

- **Provider concurrency.** Each live call holds one STT socket and issues TTS
  requests. Vendor per-account limits bite long before this process does.
- **Sockets and file descriptors.** One STT connection per call.
- **Bandwidth**, and real audio work the stubs skip: PCM decode, the
  recogniser's own work, TLS.

So `maxConcurrent: 100` is a conservative default, not a measured ceiling. Set
it to your *provider* capacity. Re-run the benchmark on your hardware, and
against real providers, before promising anyone a number.

### Ending one call without ending the service

`Transport.stop()` is process-wide. Anything that ends a *single* call must use
`closeSession(sessionId)` — including `CallSupervisor`, which does. Transports
that cannot address one session leave it undefined and the caller falls back.

### Per-call isolation

One pipeline, VAD, preprocessor, DTMF collector, STT stream and memory per call.
Provider *instances* are shared, which is safe for the streaming providers
because per-call mutable state lives on the stream, not the provider.

---

## 6. Extension points

Everything below is a supported seam. You do not need to fork the framework.

| You want to… | Do this |
|---|---|
| Rate limit, filter, or tenant-check callers | An input guardrail (runs before every turn) |
| Retry a flaky STT provider | Pass a provider **instance**: `stt: myWrappedProvider` |
| Count or shape connections | Pass a `Transport` **instance** that wraps the real one |
| Change what the agent does mid-call | `ctx.setSystemPrompt()` (needs `allowPromptOverride: true`) |
| End a call from a handler | `ctx.hangup()` — carrier-agnostic |
| Cancel slow work on interruption | `ctx.signal` — thread it into your fetch |
| Add a tool | `tools([...])` or an MCP server |
| Report what a handler spent | `ctx.reportUsage({ promptTokens, completionTokens })` |

---

## 7. Pre-flight checklist

- [ ] `maxConcurrent` set to your measured per-instance capacity
- [ ] `maxCallDurationMs` set if 30 minutes is wrong for you
- [ ] `maxConnections` set on every transport that accepts the public internet
- [ ] Webhook signature validation configured and **tested** with a real call
- [ ] `cost.prices` set if you bill per call
- [ ] `format: "json"` logging wired to a shipper, or an explicit decision not to
- [ ] `/health` and `/metrics` reachable from your orchestrator
- [ ] `npm run loadtest` run on your hardware, and again against real providers
      at your target concurrency
- [ ] Compliance handled by you: consent, DNC, recording, retention
