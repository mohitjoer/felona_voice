# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public issue
tells everyone about the flaw before it is fixed.

Email **security@felona-voice.dev** with:

- what the issue is, and what an attacker gains
- steps to reproduce, or a proof of concept
- the version or commit you tested
- your `package.json` and Node version

We aim to acknowledge within 2 business days and to ship a fix or a mitigation
within 14 days for a confirmed issue affecting a published version. We will
tell you when the fix lands, and credit you in the release notes unless you
would rather we did not.

## Scope

This framework handles live phone calls: caller speech, transcripts, and
telephony metadata. Reports we treat as in scope:

- Authentication or signature-validation bypass on any transport
  (Twilio webhook, WebSocket, WebRTC)
- A route by which untrusted input reaches a tool call or system prompt
  without passing a configured guardrail
- Cross-session data disclosure — one caller's transcript, slots, or metadata
  reaching another
- A memory or resource leak reachable from call traffic
- Injection through a channel that reaches a shell, XML, SQL, or a
  deserialiser
- Disclosure of credentials — for example, an MCP subprocess receiving
  environment variables it was not given

Out of scope: issues requiring an already-compromised host, denial of service
from a deliberately unbounded number of connections (set `maxConnections`), and
missing hardening in a caller's own deployment.

## What this framework does not do

Know what is not implemented before reporting it:

- **Compliance is the operator's responsibility.** No consent capture, DNC
  list handling, call recording, or retention policy is provided. Outbound
  calling has legal obligations — TCPA and equivalents — that this library
  does not attempt to satisfy for you.
- **No rate limiting.** Call frequency limits belong at your edge, not in
  this library. `maxConnections` and `maxConcurrent` bound concurrency but not
  request rate.
- **No encryption at rest.** Nothing is written to disk unless you supply
  `logging.logDir`, and what is written is your responsibility to protect.
- **Guardrails are opt-in.** Caller speech reaches routing, the knowledge base,
  and tool arguments uninspected unless you configure them. See
  [PRODUCTION.md](../docs/PRODUCTION.md#4-guardrails).

## Hardening notes for operators

Defaults that already protect you: outbound requests carry deadlines, batch
audio buffers are capped, card-shaped DTMF is masked in logs, MCP children do
not inherit the full environment, and concurrency is bounded.

Set before going live:

- `maxConcurrent` and `maxConnections` to your measured capacity
- Twilio `authToken` and `publicUrl` — the webhook fails closed without them
- `cost.prices` if you bill per call
- A `SessionStore` if you run more than one process, so a call can resume

Caller transcripts and phone numbers will reach whichever STT, TTS and LLM
providers you configure. Know where that data goes, and what they retain.
