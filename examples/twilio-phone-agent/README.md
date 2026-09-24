# 📞 Twilio Telephony Phone Agent Example

This example demonstrates how to connect **Felona Voice** directly to **Twilio Media Streams** to handle live telephone and mobile carrier phone calls.

---

## 🚀 How It Works

1. **Inbound Call Arrives**: A mobile user calls your Twilio phone number.
2. **Twilio Webhook Fetches TwiML**: Twilio sends an HTTP request to your Felona Voice server (`/voice`). Felona Voice automatically generates and responds with valid TwiML `<Connect><Stream>`.
3. **Bi-directional WebSocket Opens**: Twilio opens a WebSocket stream (`/media`).
4. **Live Transcoding**:
   - Inbound telephony audio (`audio/x-mulaw`, 8,000 Hz) is decoded to 16-bit linear PCM and fed to VAD + STT.
   - Outbound agent speech is synthesized, downsampled to 8kHz μ-law, and streamed back into the mobile caller's ear.
5. **Ultra-Low Latency (~5ms)**:
   Instead of waiting seconds for slow LLM tokens, Felona Voice's JEV engine selects the appropriate action in under 10 milliseconds.
6. **Barge-In Interruption Support**:
   If the caller interrupts while the agent is speaking, Felona Voice immediately sends a Twilio `clear` event to silence the phone's audio buffer instantly.

---

## 🛠️ Step-by-Step Setup

### 1. Install & Configure

```bash
# Clone and build
npm install
npm run build

# Set your STT / TTS API keys
export DEEPGRAM_API_KEY="your-deepgram-api-key"

# (Optional: for outbound calls)
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="your-auth-token"
export TWILIO_FROM="+15551234567"
```

### 2. Start the Agent Server

```bash
npx tsx ./examples/twilio-phone-agent/index.ts
```

### 3. Expose to the Internet

Twilio requires a public HTTPS/WSS URL to communicate with your local machine. Use `ngrok`:

```bash
ngrok http 8080
```

Copy the forwarding HTTPS URL (e.g. `https://abc-123.ngrok-free.app`).

### 4. Configure in Twilio Console

1. Open [Twilio Console](https://console.twilio.com) -> **Phone Numbers** -> **Active numbers**.
2. Click your phone number.
3. Scroll to **Voice Configuration**:
   - **A CALL COMES IN**: Select `Webhook`.
   - **URL**: `https://<your-ngrok-domain>.ngrok-free.app/voice`
   - **HTTP Method**: `HTTP POST`
4. Click **Save Configuration**.

### 5. Test Live!

Dial your Twilio phone number from your mobile phone! You will hear the agent answer and converse in real time.
