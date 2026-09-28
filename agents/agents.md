# Agents — Rules, Style, Skills & Process

## Rules
- [2026-09-21] Open source from day one
- [2026-09-21] TypeScript/Node.js only — no Python backend
- [2026-09-21] JEV is the core differentiator — never reduce it to a wrapper
- [2026-09-22] License requires explicit attribution ("Powered by Felona Voice") on any product or service using the framework
- [2026-09-22] Never mention third-party framework or tool names (such as LangChain, LangGraph, etc.) in package metadata, keywords, code, or documentation. Use native Felona Voice terminology.
- [2026-09-24] Never persist session data, audio, or logs anywhere (no disk, no database) unless the user explicitly provides a database connection, external store, or storage location. Ephemeral in-memory state during active connection only by default.
- [2026-09-27] Never emit `error` on a bare `EventEmitter`. Node throws when the event has no listener, turning any recoverable hiccup into a process crash. Use a guarded `emitSafe`, or a non-`error` event name (e.g. `sttError`).
- [2026-09-27] Every `Promise` created in a constructor or a fire-and-forget call site must be handled. An unhandled rejection in Node 20+ terminates the process by default.
- [2026-09-27] Documentation must not claim a capability the code does not have. When a feature is unimplemented, the API must throw rather than log and continue.
- [2026-09-27] Never interpolate user- or config-supplied strings into HTML, Mermaid, XML, or shell command strings. Escape at the boundary, or use an argv-based API.
- [2026-09-27] Validate inputs that would otherwise fail silently or corrupt state: duplicate IDs, inverted thresholds, dimension mismatches, and identity fields sourced from user input.
- [2026-09-27] Extractors must not fire on unrelated input. A pattern that matches inside a longer token run (a 16-digit card number yielding a bogus expiry) is a bug, not a lenient parser. Use digit/word boundaries and context guards.
- [2026-09-27] When validating voice input, be forgiving on format and strict on meaning. Re-ask on a value that fails validation; never accept an unvalidated one.
- [2026-09-27] Speculative work must be separable from committed work (plan/commit split), so an abandoned attempt leaves no trace in memory, hooks or analytics.
- [2026-09-27] Never abandon a speculative result you are about to read. Detach it first, then consume; marking it abandoned guarantees the work is thrown away.
- [2026-09-27] Side effects that must happen after the agent speaks (call transfer, hangup) are staged by the handler and executed by the pipeline once speech completes, so the caller hears the whole reply.
- [2026-09-27] Builder caches must be invalidated when their inputs change. `build()` returning a cached agent built from a shorter action list silently drops later actions.
- [2026-09-27] Retrieval needs a similarity floor. Without one, an unrelated query returns the least-bad passage and the agent answers from it confidently.
- [2026-09-27] Never synthesise answers on the caller's behalf. Retrieval returns passages; a required handler function decides the wording.
- [2026-09-28] Every outbound network call needs a deadline. `AbortSignal` is passed to `fetch`, not raced against a timer — a request that is merely abandoned keeps its socket. A hung provider otherwise wedges a turn forever, because the pipeline serialises turns behind one flag.
- [2026-09-28] Provider HTTP goes through `resilience/http.ts`. Hand-rolled `fetch` at a call site has no timeout, no retry and no breaker, so one vendor blip becomes a failed call.
- [2026-09-28] Retry only what is safe to retry: connection establishment and idempotent reads. Never mid-stream, once audio is flowing.
- [2026-09-28] A dropped provider socket must reconnect, or the agent goes silently deaf for the rest of the call. Bounded attempts, then report once.
- [2026-09-28] Ending one call must never call `transport.stop()`. Use `closeSession()`; `stop()` is process-wide and drops every other caller.
- [2026-09-28] An unverifiable webhook request is a rejected request. Auth that defaults to open is opt-out, never opt-in.
- [2026-09-28] Session identity is server-owned. A client may annotate metadata but never overwrite the fields routing or call handling trust.
- [2026-09-28] Every in-memory per-call buffer is capped. A turn that never ends must not grow a buffer for the length of the call.
- [2026-09-28] A promise chain that serialises work must recover from rejection, or one failure poisons every later item in the chain.
- [2026-09-28] Bounds are finite by default. `Infinity` concurrency and unbounded call duration are deployment incidents waiting to happen.
- [2026-09-28] A caller who speaks while the agent is *thinking* is an interruption too. Barge-in detection gated on `isSpeaking` alone leaves a slow handler running to completion for a reply nobody will hear. Abort the turn, and drop its result rather than committing it.
- [2026-09-28] A handler that can run for seconds gets an `AbortSignal`. A turn's work is abandoned on interruption and its result is discarded, not spoken and not filed as history.
- [2026-09-28] Hooks return nothing the pipeline uses, so awaiting one adds only latency. Make `hooksMode: "detach"` available, but keep `await` the default: a hook may legitimately write state the next stage reads.
- [2026-09-28] Guardrails fail closed. A guardrail that throws blocks the turn; a content filter that crashes silently is worse than no filter.
- [2026-09-28] An unknown tool name ends the LLM tool loop. Re-asking every remaining iteration burns tokens on a name that will never resolve.
- [2026-09-28] Streamed tool-call deltas must be reassembled by index. Name and arguments arrive across chunks; reading only the first frame drops the call or corrupts its JSON.
- [2026-09-28] Never embed a price table as a default. It goes stale and silently misreports spend; the operator supplies prices.
- [2026-09-28] A cost feature is not a cost feature until something populates it. A tracker with no caller measures nothing, and the unenforced path is always the one that rots.
- [2026-09-28] "Works against most providers" is a claim, not a fact. Two API shapes that look similar diverge on the one detail that matters; verify against the actual wire format before promising it.
- [2026-09-28] Replay a tool-calling turn in the provider's own shape. Flattening content blocks to a string breaks the id linkage that matches a result to its request.

## Style Patterns (Non-Linter)

### Naming
- Files: kebab-case
- Classes/Types: PascalCase
- Functions/variables: camelCase

### Structure
- Monorepo: npm workspaces (packages/core, packages/cli)
- Each module: implementation file + barrel index.ts
- All interfaces in types.ts at src root
- Tests in tests/ alongside src/

### Patterns Observed
- [2026-09-21] Every module exports a factory function (createX) alongside the class
- [2026-09-21] All providers implement interfaces from types.ts
- [2026-09-21] EventEmitter used for pipeline/memory events
- [2026-09-21] One pipeline instance per session (isolated state)
- [2026-09-21] Stateful workflow graphs use VoiceGraph with .addNode, .addEdge, .compile, .invoke
- [2026-09-27] Optional capability on a provider interface uses `?` (e.g. `STTStream.flush`, `STTStream.onError`) so existing implementations stay valid
- [2026-09-27] Shared cross-module contracts are declared in types.ts as narrow interfaces (e.g. `SessionAccessor`) rather than importing concrete classes or using `any`
- [2026-09-27] In-memory maps keyed by session id are LRU-bounded and expose an explicit reset/clear method
- [2026-09-27] Concurrency limits are enforced inside the component that owns the resource, with the reservation taken synchronously before any `await`


## Known Skills
- [2026-09-21] find-skills — present
- [2026-09-21] frontend-design — present
- [2026-09-21] seo-in-nextjs — present
- [2026-09-21] web-design-guidelines — present
- [2026-09-21] ui-ux-pro-max — present
- [2026-09-21] brandkit — present
- [2026-09-21] design-taste-frontend — present
- [2026-09-21] react-doctor — present

## Definition of Done
- [ ] Lints pass (`npm run lint` — ESLint 9 flat config, `no-unused-vars` is an error)
- [ ] Types pass (`npm run typecheck` — must use `tsconfig.check.json`; the root `tsconfig.json` uses project references with `files: []` and checks nothing)
- [ ] Tests pass (`npm test`)
- [ ] Build passes (`npm run build`)
- [ ] Change maps back to a goal in PRD.md
- [ ] Any new rule or style pattern stated this session was recorded
- [ ] AGENTS.md / GEMINI.md / CLAUDE.md still exist and still point to agents/agents.md
- [ ] Docs describe only behaviour the code actually has

## Gotchas Learned
- The root `tsconfig.json` is references-only. `tsc --noEmit -p tsconfig.json` silently checks zero files; it looks green while type errors exist. Use `npm run typecheck`.
- Vitest transpiles without type-checking, so a type error can sit in a passing test suite. `npm run build` and `npm run typecheck` are the only type gates.
- A constructor that opens a WebSocket must handle its own connect promise; the pipeline creates the stream per call and never awaits it.
