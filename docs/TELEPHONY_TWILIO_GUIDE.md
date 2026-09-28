# 📞 Telephony & Mobile Carrier Integration (Twilio & Telnyx)

Felona Voice provides built-in, first-class support for telephone calls over mobile networks and PSTN via **Twilio Media Streams** and **Telnyx TeXML**.

---

## ⚠️ Breaking change: webhook authentication is now required

Earlier versions accepted **unsigned** webhook requests, which meant anyone who
could reach the port could place calls into your agent. Signature validation
now **fails closed**: a request that cannot be verified is rejected with `403`.

If you are upgrading an unauthenticated setup, either configure the two values
below, or opt out explicitly:

```typescript
.twilio({
  authToken: process.env.TWILIO_AUTH_TOKEN,  // enables X-Twilio-Signature
  publicUrl: "https://voice.example.com",   // the URL Twilio actually calls
  // allowUnverified: true,  // only if the webhook is not publicly reachable
})
```

The `/media` media WebSocket is gated by the same `authToken` when it is set.
`agent.listenTwilio()` accepts `authToken` and `publicUrl` directly if you are
not using the builder.

---

## ⚡ Key Highlights

- **Native G.711 μ-law (PCMU) Transcoding**: Built-in, zero-dependency, microsecond bi-directional conversion between 8kHz μ-law phone audio and 16-bit linear PCM (8kHz, 16kHz, 24kHz, 48kHz).
- **Instant Next-Action Routing**: JEV matches caller utterances with in-process cosine similarity — no model call in the routing path, so no conversational pause while waiting on one.
- **Instant Barge-In / Interruption**: When a caller speaks over the agent, Felona Voice immediately sends a Twilio `clear` event to flush queued audio on the caller's mobile phone.
- **Zero-Config TwiML Auto-Serving**: The built-in telephony server handles both the WebSocket stream (`/media`) and the HTTP voice webhook (`/voice`) with auto-generated TwiML.
- **Express / Fastify / Next.js / Custom Server Compatible**: Easily pluggable into existing HTTP servers via `agent.handleTwilioWebSocket(ws, req)`.
- **Outbound Phone Calling**: Place outbound phone calls programmatically using `makeTwilioCall(...)`.

---

## 🛠️ Quick Start (Zero-Boilerplate Standalone Server)

```typescript
import { createAgent } from "felona-voice";

const agent = createAgent("Receptionist")
  .system("You are a friendly customer service phone receptionist.")
  .deepgram({
    apiKey: process.env.DEEPGRAM_API_KEY,
    ttsVoice: "aura-asteria-en",
  })
  .action("hours", "Inquire about opening and closing business hours", async () => {
    return "We are open Monday through Friday from 8:00 AM to 6:00 PM Eastern time.";
  })
  .action("schedule", "Book, modify, or cancel an appointment", async (ctx) => {
    const caller = ctx.session.metadata.from || "there";
    return `I can help you schedule an appointment for ${caller}. What day works best?`;
  })
  .fallback("Thank you for calling. How can I help you today?")
  .twilio({
    port: 8080,
    path: "/media",
    webhookPath: "/voice",
    greeting: "Thank you for calling. Connecting to customer service.",
    // Required. Without these the webhook rejects every request with 403.
    authToken: process.env.TWILIO_AUTH_TOKEN,
    publicUrl: process.env.PUBLIC_URL, // e.g. "https://voice.example.com"
  });

// Start the server (serves TwiML at /voice and WebSocket at /media):
await agent.listenTwilio({ port: 8080 });
```

`publicUrl` must be the URL Twilio actually requests, because Twilio's
signature covers that exact URL. `ngrok` URLs change between runs, so a
hardcoded `publicUrl` will fail validation after a restart.

---

## 🌐 Connecting to Twilio Console

1. Expose your local port with ngrok (or deploy your server to AWS, Render, Fly.io, etc.):
   ```bash
   ngrok http 8080
   ```
2. In the [Twilio Console](https://console.twilio.com):
   - Go to **Phone Numbers** -> **Manage** -> **Active numbers**.
   - Click on your phone number.
   - Under **Voice Configuration**:
     - Set **A CALL COMES IN** to `Webhook`.
     - Enter URL: `https://<your-domain>/voice` (HTTP POST).
     - Save changes.
3. Call the phone number from your mobile phone!

---

## 🧩 Integration with Existing Express or Node.js Servers

If you already have an Express, Fastify, or custom Node `http.Server`, you can attach Felona Voice directly:

```typescript
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createAgent, createTwilioStreamTwiML } from "felona-voice";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

const agent = createAgent("SupportBot")
  .system("You are a phone assistant.")
  .action("billing", "Billing questions", async () => "Your current balance is zero dollars.")
  .fallback("How can I assist you with your account today?");

// 1. TwiML Webhook route in Express
app.post("/voice", (req, res) => {
  const twiml = createTwilioStreamTwiML({
    streamUrl: `wss://${req.headers.host}/media`,
    greeting: "Connecting you now...",
  });
  res.type("text/xml").send(twiml);
});

// 2. Pass incoming WebSocket connections to the agent
wss.on("connection", (ws, req) => {
  agent.handleTwilioWebSocket(ws, req);
});

server.listen(8080, () => {
  console.log("Server listening on port 8080");
});
```

---

## 📤 Programmatic Outbound Calls

Initiate outbound mobile phone calls to prospects or customers directly:

```typescript
import { makeTwilioCall } from "felona-voice";

const call = await makeTwilioCall({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  from: "+15551234567",
  to: "+15559876543",
  streamUrl: "wss://voice.mycompany.com/media",
  customParameters: {
    customerName: "Alex",
    priority: "high",
  },
});

console.log(`Outbound call dispatched: ${call.callSid}`);
```

---

## 📊 Session Metadata for Telephony Calls

When a mobile caller connects, `session.metadata` contains:

```typescript
{
  telephony: "twilio",
  streamSid: "MZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  callSid: "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  from: "+15551234567",   // Caller's phone number
  to: "+15559876543",     // Twilio phone number called
  customParameters: { ... },
  tracks: ["inbound"],
  mediaFormat: {
    encoding: "audio/x-mulaw",
    sampleRate: 8000,
    channels: 1
  }
}
```

You can access these in any action handler via `ctx.session.metadata`.
