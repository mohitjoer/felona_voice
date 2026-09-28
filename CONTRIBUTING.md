# Contributing to Felona Voice

Felona Voice is an open-source voice agent framework. Contributions are welcome
— bug reports, provider implementations, documentation, and ideas all help.

**Read [`agents/agents.md`](./agents/agents.md) before changing source.** It is
the project's master rulebook: the design rules the codebase follows, and the
reason several obvious-looking "improvements" are deliberately absent. New rules
learned while working on the code are recorded there as part of your change.

---

## Prerequisites

- **Node.js ≥ 20.0.0** (the framework uses `AbortSignal`, which is why)
- **npm ≥ 10.0.0**

No other tooling is required. There is no build step for native modules, which
is intentional: `npm install` is fast and the install surface is small.

---

## Getting started

```bash
git clone https://github.com/your-username/felona-voice.git
cd felona-voice
npm install          # installs both workspaces
npm run build        # compile core + cli
npm test             # 593 tests across core and cli
```

Useful during development:

```bash
npm run dev                    # watch-build core
npm run test:watch --workspace=packages/core
npm run loadtest -- 200 4      # synthetic concurrency benchmark
```

---

## The gates

All five must pass before a pull request can merge. They are exactly what CI
runs, so running them locally is faster than waiting for CI.

```bash
npm run typecheck   # tsc --noEmit -p tsconfig.check.json
npm run lint        # eslint over packages/*/src and scripts/
npm run build       # compile both packages
npm test            # vitest across workspaces
npm run loadtest    # concurrency smoke test
```

**`npm run typecheck` is not `npx tsc`.** The root `tsconfig.json` uses project
references with `files: []`, so typechecking it validates nothing and looks
green while type errors exist. `tsconfig.check.json` is the config that
actually checks source. This trips up people regularly.

Vitest transpiles without type-checking, so a type error can sit inside a
passing test suite. `npm run build` and `npm run typecheck` are the only type
gates — run both.

---

## Repository structure

```
packages/
├── core/
│   ├── src/
│   │   ├── agent.ts          FelAgent — main entrypoint
│   │   ├── builder.ts        Fluent AgentBuilder API
│   │   ├── pipeline.ts       Per-call audio pipeline (one per session)
│   │   ├── types.ts          Every shared interface lives here
│   │   ├── guardrails/       Pre-routing and pre-speaking checks
│   │   ├── llm/              LLM providers (OpenAI-compatible, Anthropic)
│   │   ├── jev/              Joint Embedding Vector routing
│   │   ├── memory/           ConversationMemory
│   │   ├── observability/    Traces, metrics, cost accounting
│   │   ├── resilience/       Timeouts, retry with backoff
│   │   ├── session/          Session management and stores
│   │   ├── stt/              Speech-to-Text providers
│   │   ├── telephony/        Twilio, transfer, TwiML
│   │   ├── tts/              Text-to-Speech providers
│   │   ├── transport/        WebSocket, WebRTC, ops endpoints
│   │   └── voicemail/        Answering-machine detection
│   └── tests/
├── cli/                      felona-cli — visualize and test commands
docs/                        Guides, API reference, production guide
examples/                    Runnable reference examples
scripts/loadtest.ts           Concurrency benchmark
```

---

## Testing guidelines

- Tests live in `packages/*/tests/`, named after the module they cover
  (`kebab-case.test.ts`).
- **A test must fail if the behaviour it names is broken.** Assert on the
  specific property, not merely that a call did not throw.
- Non-trivial logic — a branch, a loop, a parser, a security or billing path —
  needs a test. Trivial one-liners do not.
- Never assert on something that only happens to be true today without saying
  why. A comment saying why the value is what it is prevents the next person
  from "fixing" it.
- When fixing a bug, add the test that would have caught it. If a bug shipped
  because every test passed, that is the test's gap, not the bug's.

---

## Coding standards

- **TypeScript, ESM only** (Node ≥ 20). Relative imports carry a `.js`
  specifier.
- **Naming**: files `kebab-case.ts`, classes and types `PascalCase`, functions
  and variables `camelCase`.
- **Shared interfaces go in `packages/core/src/types.ts`.** Providers
  implement them. A new capability on a provider interface is optional (`?`) so
  existing implementations stay valid.
- **One pipeline instance per session.** Per-call state belongs to the
  pipeline, never to a shared provider — provider instances are shared across
  concurrent calls, so mutable state on one is a cross-talk bug.
- **In-memory maps keyed by session id are LRU-bounded** and expose a clear
  method.
- **Concurrency limits are enforced by the component that owns the resource**,
  with the reservation taken synchronously before any `await`.
- **Documentation must not claim a capability the code lacks.** If a feature is
  unimplemented, the API throws rather than logging and continuing.
- **Keep dependencies minimal.** Hand-rolled `fetch` is deliberate: it keeps the
  install surface small. Add a dependency only when the alternative is
  genuinely worse, and say why in the PR.

The full rule set, with the reasoning behind each rule, is in
[`agents/agents.md`](./agents/agents.md).

---

## Commit and PR conventions

Commit messages use a conventional prefix so the history stays readable:

```
fix(core): bound every provider call and close the crash paths
feat(core): add guardrails and voicemail detection
docs: remove documentation for capabilities the code lacks
test: cover the assembly lifecycle
chore(release): 3.0.0
```

Scope is the short package or area in parentheses where it aids scanning.

A good pull request:

- Explains **why**, not only what changed. A reviewer can usually infer the
  diff; they cannot infer the motivation.
- Notes the behaviour change if a caller could notice one. Breaking changes
  belong in `CHANGELOG.md` under the unreleased version.
- Says what you verified and how. "Load tested at 2000 calls" is useful;
  "tested" is not.
- Splits unrelated changes. A refactor and a behaviour change in one commit is
  two pull requests.

---

## Adding a provider

The pattern is consistent across STT, TTS, and VAD:

1. Implement the interface from `types.ts`.
2. Export a `createXProvider(...)` factory alongside the class.
3. Give the provider a **default deadline** and use
   `fetchWithTimeout`/`requestStream` from `resilience/` rather than a bare
   `fetch`. A provider without a timeout can wedge a call: the pipeline
   serialises turns behind one flag, so one hung request stops the caller
   being answered.
4. Bound every buffer. An unbounded array that grows for the length of a call
   is a leak, and a turn may never end.
5. Add a test that stubs `fetch` and asserts the deadline and abort are wired.

---

## What needs a maintainer

Open a discussion first for changes that alter a public interface, add a
runtime dependency, change default limits, or touch `agents/agents.md`.
Those are decisions with long-lived consequences, not patches.

---

## Reporting bugs

Include what you expected, what happened, a minimal reproduction, and the
output of `npm run typecheck && npm test`. Version numbers matter here: this is
a fast-moving codebase and "latest" is not a useful reference.

**Security issues are not bugs** — please do not open a public issue. See
[SECURITY.md](./.github/SECURITY.md).

---

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
