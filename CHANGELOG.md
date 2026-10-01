# Changelog

All notable changes to Felona Voice are recorded here. This project follows
[Semantic Versioning](https://semver.org/).

## [3.0.1] — 2026-10-01

Additive release. Local routing is untouched and remains the default, so this
upgrades without changing how an existing agent behaves.

### Added

- **Decision-model routing** via `builder.decision()` and `jev.decision`. The
  action space is sent as one `choice` question per turn and comes back with a
  probability per action, instead of being matched by cosine similarity. Local
  routing is unchanged and remains the default; opting in costs a network hop
  per turn.
  `SystemOneDecisionProvider` speaks the System One wire protocol
  (`POST /v1/systemone`), which the hosted service and most self-hosted decision
  servers serve — pointing `baseUrl` at a local one is the only change needed.
  Pass a `DecisionProvider` instance to use a different backend.

  A failed decision call routes to `fallback` rather than failing the turn
  (`onError: "throw"` to opt out). A response that violates the contract — an
  unoffered choice, a question left unanswered — always throws, because
  degrading it would hide the bug behind a plausible reply.

## [3.0.0] — 2026-09-28

The production-hardening release. **Breaking:** the Twilio webhook now rejects
requests whose signature cannot be verified. See
[the telephony guide](./docs/TELEPHONY_TWILIO_GUIDE.md#breaking-change-webhook-authentication-is-now-required)
before upgrading.

### Breaking

- **Twilio webhook authentication fails closed.** An unverifiable request is
  rejected with `403` instead of being accepted. Previously
  `X-Twilio-Signature` validation was skipped whenever `authToken`/`publicUrl`
  were unset, which meant anyone who could reach the port could place calls
  into your agent. Configure both, or opt out with `allowUnverified: true`.
  `builder.twilio()` now accepts `authToken`, `publicUrl`, `allowedHosts` and
  `allowUnverified`; previously it accepted no auth options at all, so the
  documented entry point could not be secured.
- **The `/media` media WebSocket is authenticated** when `authToken` is set.
- **Session IDs are server-owned.** A `session.update` control message can no
  longer overwrite `from`, `to`, `callSid`, `caller`, `phoneNumber`,
  `accountSid`, `streamSid` or `telephony`. A live `streamSid` is rejected
  rather than overwriting an existing call.
- **Concurrency is bounded.** `sessions.maxConcurrent` defaults to `100` per
  agent instead of unbounded, and calls are ended after 30 minutes by default
  (`maxCallDurationMs`). Set `maxConcurrent` to your measured capacity and
  `maxCallDurationMs: 0` to disable the ceiling.
- **MCP subprocesses no longer inherit the full parent environment.** A child
  receives only `PATH`/`HOME`/`TMPDIR` (plus its own `env`) unless the server
  sets `inheritEnv: true`. Previously every MCP server received every provider
  API key in the process.
- **Bounded audio buffers.** Batch STT providers (Whisper, Azure, Google) cap
  accumulated audio and discard the oldest, reporting the drop. Previously a
  turn that never ended grew a buffer for the length of the call.
- **Removed the `onnxruntime-node` optional peer dependency.** It advertised a
  capability the code never had: `loadPredictor()` throws `not supported`, and
  the documentation that described ONNX support has been removed.

### Added — resilience

- New `resilience/` module: `fetchWithTimeout`, `retry` (exponential backoff
  with jitter), and `requestStream`. Every outbound provider call now has a real
  deadline — the composed `AbortSignal` reaches `fetch`, so an overrunning
  request has its socket torn down rather than abandoned. Retries apply to
  connection establishment and idempotent reads only, never mid-stream.
- Deepgram reconnects after an unexpected socket drop (bounded attempts), rather
  than leaving the agent silently deaf for the rest of the call.
- AssemblyAI terminates a socket still in `CONNECTING` on `close()`, buffers
  and replays pre-connect audio, waits for the handshake in `flush()`, and has
  a 10s handshake deadline.
- Telephony WebRTC peers are reaped after a configurable
  `disconnected` grace period.

### Added — voice capabilities

- `LLMProvider` with `createOpenAILLM` (any OpenAI-compatible endpoint) and
  `createAnthropicLLM` (Claude's Messages API), plus `builder.llm()` for a
  catch-all action. Streaming, tool-calling loop, cancellation, token usage.
- **Background cancellation.** `ctx.signal` aborts on interruption, voicemail
  hangup and pipeline stop. An interrupted turn is dropped rather than
  committed, so a talked-over reply never enters conversation history or
  triggers a staged transfer. Previously barge-in was only detected while the
  agent was *speaking*, so a caller interrupting a slow handler was ignored.
- `hooksMode: "detach"` moves observer hooks off the turn critical path.
  `onCallEnd` remains awaited so a call log cannot be lost at shutdown.
- **Guardrails** run before routing (caller speech) and before speaking (agent
  reply). A guardrail that throws blocks the turn.
- **Voicemail detection**, phrase-based over the transcript, with a grace window
  and a settled verdict. Adds `ctx.hangup()` and `Transport.closeSession()`.
- **Per-call cost tracking** via `cost: { prices, onCallCost }`, with metrics
  for tokens and estimated spend. `ctx.reportUsage()` attributes LLM spend.
- Mid-call `setSystemPrompt()` behind `allowPromptOverride`.
- Server-side noise cancellation for Deepgram and Azure.

### Added — observability and operations

- `MetricsRegistry` and `/metrics` (Prometheus text format) on every transport.
- `/health` on all three transports, returning `503` at capacity so a load
  balancer stops sending traffic.
- `logging.format: "json"` for one-object-per-line output.
- Stale pipeline reaper for calls that never receive a disconnect.

### Fixed (v3.0.1)

- `CallSupervisor.disconnect()` no longer calls `transport.stop()`, which tore
  down the whole server and every concurrent call.
- Disconnect fires exactly once per call on shutdown, instead of twice.
- WebRTC `direction` and `verifyClient` are no longer silently dropped.
- A rejected promise in a batch-STT flush queue no longer poisons every later
  flush and `close()`.
- Provider error messages now carry the HTTP status, so a `401` is
  distinguishable from a `429`.
- The Google STT API key is sent as a header rather than a URL query parameter.
- SSML interpolation in Azure TTS is escaped, closing an injection path.
- `interact()` turns are serialised per session, so concurrent calls can no
  longer interleave and lose context.
- The JEV action space swaps atomically, removing a window where a concurrent
  `match()` could throw.
- The builder no longer duplicates knowledge actions across rebuilds.
- An unknown tool name ends the LLM tool loop instead of re-asking on every
  remaining iteration.

### Changed

- `werift` is an **optional** peer dependency. Install it only for
  `WebRTCTransport`; the rest of the framework works without it.
- Documentation: new [Production Guide](./docs/PRODUCTION.md) and
  [Agent Capabilities](./docs/AGENT_CAPABILITIES.md); ONNX claims removed;
  broken cross-doc links fixed.
- CI installs with `npm ci` alone and audits production dependencies.
- All GitHub Actions are SHA-pinned with a version comment. A mutable tag is
  a supply-chain hole: the tag can move to a new commit under a review that
  looked at the old one.
- New `pr-checks.yml` gates every pull request: typecheck/lint/build/test, a
  clean-install smoke test of the packed tarball, docs integrity, a concurrency
  smoke test, and a production dependency audit.
- `dependabot.yml`, `CODEOWNERS` and `SECURITY.md` added.
- `npm run check` runs every local gate in the order CI does.
- `npm run loadtest` benchmarks N concurrent calls through real pipelines with
  stubbed providers, and `docs/PRODUCTION.md` records the measured result: the
  framework's own per-turn work is not the bottleneck; provider concurrency is.

### Not in this release

Stated plainly so it is not mistaken for an oversight: rate limiting, TURN/SFU
media infrastructure, and compliance capture (consent, DNC, recording). A
load test is included; what is not included is a measurement against real
providers, which depends on your accounts and hardware. See
[PRODUCTION.md](./docs/PRODUCTION.md) for why the rest belongs outside the
framework.

## [0.2.6] and earlier

See the repository history.
