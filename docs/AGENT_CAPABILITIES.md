# 🧠 Agent Capabilities

The voice-loop features: conversation, interruption economy, safety, and call
control. Each one is opt-in unless noted.

---

## 1. LLM-backed actions

You can write a handler that calls any model, or use the built-in providers.
`builder.llm()` registers a catch-all action that JEV still routes to, so a
narrow deterministic action wins where one exists and the model covers the rest.

```typescript
import { createOpenAILLM, createAnthropicLLM } from "felona-voice";

const llm = createOpenAILLM({ apiKey: process.env.OPENAI_API_KEY });

createAgent("Support")
  .deepgram({ apiKey: process.env.DEEPGRAM_API_KEY, ttsVoice: "aura-asteria-en" })
  .action("order_status", "Check delivery status or tracking", async () => "It shipped.")
  .llm("anything else the caller asks", { llm })   // the long tail
  .fallback("Sorry, could you repeat that?");
```

`createAnthropicLLM` speaks the Messages API, which differs from the
OpenAI-compatible one: `system` is a top-level field, tools are `tool_use`
content blocks, and the streaming protocol is different. The two are not
interchangeable; the framework provides both rather than pretending.

Both providers handle streaming, the tool loop, cancellation, and token
accounting. Tools come from the agent's registry, so `tools([...])` and MCP
servers work with an LLM action without extra wiring.

> An unknown tool name ends the loop rather than re-asking on every remaining
> iteration. Truncated tool arguments fall back to `{}` instead of discarding
> the whole reply.

---

## 2. Background cancellation

A caller who interrupts while the agent is *thinking* is an interruption too —
and the pre-existing barge-in path only handled the agent *speaking*. Without
this, a slow handler finished a reply the caller had already talked past, and
you paid for every token.

```typescript
.action("answer", "answer a hard question", async (ctx) => {
  const res = await fetch("https://internal-api/answer", {
    method: "POST",
    body: JSON.stringify({ q: ctx.conversation.currentUtterance }),
    signal: ctx.signal,          // aborted on interruption
  });
  return res.text();
});
```

`ctx.signal` aborts on barge-in, on voicemail hangup, and on pipeline stop. An
interrupted turn is **dropped**, not committed: the reply never enters the
conversation history and never triggers a staged transfer. It is reported as
`felona_turns_abandoned_total` and a `turnAbandoned` event.

The LLM providers already honour `ctx.signal` for you.

---

## 3. Non-blocking hooks

No hook returns a value the pipeline uses, so awaiting one adds only its
latency to the caller's wait.

```typescript
new FelAgent({
  hooksMode: "detach",     // "await" is the default
  hooks: {
    onAgentSpoke: async (text) => { await crm.log(text); },
    onCallEnd:    async (_s, turns) => { await analytics.record(turns); },
  },
});
```

Default stays `await` deliberately: a hook may legitimately write state the
next stage reads, e.g. `onUserSpoke` capturing a caller id a handler then
looks up. Detached hooks have their failures contained and logged.

`onCallEnd` is **always** awaited, even in detach mode — the call is over, so
there is no latency to save, and it is where the call is logged. Detaching it
would let a shutting-down process lose the record it was asked to keep.

---

## 4. Guardrails

See [PRODUCTION.md §4](PRODUCTION.md#4-guardrails) for the full reference.

```typescript
import { blockPattern } from "felona-voice";

guardrails: {
  input:  [blockPattern(/ignore (all )?(previous )?instructions/i, "injection")],
  output: [/* your own compliance rules */],
}
```

Input guardrails run before routing, retrieval and tool calls. Output
guardrails run before anything is spoken. A guardrail that throws blocks the
turn, because a filter that crashes silently is worse than no filter.

---

## 5. Voicemail detection

An outbound call that reaches voicemail is billed, ties up a concurrency slot,
and produces a turn that routes as if a human spoke — which is how a campaign
reports a 40% answer rate.

```typescript
new FelAgent({
  voicemail: { graceMs: 6000, threshold: 2 },
});

agent.on("voicemailDetected", ({ sessionId, transcript }) => { /* ... */ });
```

Phrase-based over the transcript, so it works with any STT provider and costs
nothing extra. The `graceMs` window exists because a machine greeting and a
human answering late sound identical for the first second or two. Once the
verdict settles it does not flip, so a person saying "leave a message after the
beep" mid-call does not end a real conversation.

Needs a transport that can end a call. If yours cannot, detection warns and the
call continues rather than silently doing nothing.

`ctx.hangup()` is the carrier-agnostic way for any handler to end a call.

---

## 6. Mid-call prompt override

```typescript
new FelAgent({ allowPromptOverride: true });

.action("offer", "make a retention offer", async (ctx) => {
  if (alreadyDeclinedTwice(ctx.memory)) {
    ctx.setSystemPrompt?.("Customer has declined twice. Be brief, do not re-offer.");
  }
  return "We can hold the price for 30 days if that helps?";
})
```

Takes effect from the **next** turn; a turn in flight still answers under the
prompt it started with. Off by default: a handler that can rewrite its own
instructions can be talked into doing so by a caller.

---

## 7. Noise cancellation

Server-side, via your STT provider. Off by default — it costs extra per minute
and can attenuate consonants on a clean line, so enable it per call profile.

```typescript
stt: { provider: "deepgram", apiKey, noiseReduction: "heavy" }   // off | light | heavy
stt: { provider: "azure", apiKey, region, noiseReduction: "medium", speechEnhancement: "quality" }
```

---

## 8. Interruption configuration

Not new, but the tuning that matters most alongside the above:

```typescript
new FelAgent({
  endpointing: { detection: "stt", minDelayMs: 300, maxDelayMs: 2000 },
  interruption: { enabled: true, mode: "adaptive", minWords: 3, falseInterruptionTimeoutMs: 1500 },
  preemptive: { enabled: true },   // plan while the caller is still speaking
});
```

- **`preemptive`** is the largest single latency win available: the agent starts
  planning before the caller finishes, and discards the attempt if the final
  transcript differs. Turn planning and committing are separate so an abandoned
  speculation leaves no trace.
- **`interruption.mode: "adaptive"`** continues playback while qualifying the
  overlap, so a cough does not permanently silence the agent. A false
  interruption resumes from the last audio position without re-synthesising.
- **`detection: "stt"`** defers turn detection to the recogniser's own
  endpointing, which beats a fixed silence window when your provider is good at
  it.

The known ceiling: turn endpointing is timers, VAD and provider signalling, not
a learned model. A small model trained on audio plus transcript to predict
"this thought is finished" is the next meaningful improvement, and the
`dynamic` window is where it would plug in.
