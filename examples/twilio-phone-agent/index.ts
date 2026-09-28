/**
 * Twilio Phone Agent Example — Felona Voice
 *
 * This agent answers inbound mobile phone calls or places outbound phone calls
 * using Twilio Media Streams, with ~5ms JEV neural intent routing.
 *
 * Setup:
 * 1. Set environment variables:
 *    export DEEPGRAM_API_KEY="your-deepgram-key"
 *    export TWILIO_ACCOUNT_SID="ACxxxx"     (optional for outbound calls)
 *    export TWILIO_AUTH_TOKEN="your-token"  (optional for outbound calls)
 *
 * 2. Start the agent:
 *    npx tsx ./examples/twilio-phone-agent/index.ts
 *
 * 3. Expose port 8080 to the internet with ngrok:
 *    ngrok http 8080
 *
 * 4. Configure your Twilio Phone Number:
 *    - In Twilio Console -> Phone Numbers -> Active Numbers -> Configure:
 *    - "A CALL COMES IN": Webhook (HTTP POST) -> https://<your-ngrok-url>.ngrok-free.app/voice
 */

import {
  createAgent,
  makeTwilioCall,
} from "felona-voice";

/**
 * Reads a required environment variable.
 *
 * `process.env.X` is `string | undefined`, so passing it straight to an API
 * expecting `string` is both a type error and a runtime failure with an
 * unhelpful message. Failing here names the variable that is missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Export it before starting: ${name}="..."`);
  }
  return value;
}

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || `localhost:${PORT}`;

// 1. Build conversational voice agent with zero-latency JEV routing
const phoneAgent = createAgent("Hotel Front Desk")
  .system("You are a professional hotel front desk receptionist. Be concise, polite, and helpful.")
  .deepgram({
    apiKey: requireEnv("DEEPGRAM_API_KEY"),
    ttsVoice: "aura-asteria-en",
  })
  .action(
    "room_reservation",
    "Customer wants to book a hotel room, check room availability, or inquire about rates",
    async (ctx) => {
      const callerNumber = ctx.session.metadata.from || "caller";
      return `Thank you for calling. We have deluxe king rooms and executive suites available tonight starting at 189 dollars. Would you like me to reserve one for your number, ${callerNumber}?`;
    }
  )
  .action(
    "checkout_time",
    "Customer asks about checkout time, late checkout, or check-in hours",
    async () => {
      return `Standard check-in is at 3:00 PM and checkout is at 11:00 AM. Complimentary late checkout until 1:00 PM is available upon request.`;
    }
  )
  .action(
    "amenities",
    "Customer asks about breakfast, swimming pool, gym, Wi-Fi, or parking",
    async () => {
      return `Our heated rooftop pool and fitness center are open 24 hours. A complimentary hot breakfast buffet is served on the second floor from 6:30 to 10:00 AM.`;
    }
  )
  .action(
    "speak_human",
    "Customer demands to talk to a human manager, front desk supervisor, or emergency operator",
    async () => {
      return `Please hold on for just a moment while I transfer you directly to our front desk manager on duty.`;
    }
  )
  .action(
    "goodbye",
    "Customer says thank you, goodbye, or that their question has been answered",
    async () => {
      return `You're very welcome! Have a wonderful day and we look forward to welcoming you soon.`;
    }
  )
  .fallback(
    "I am here to help with hotel room reservations, amenities, and front desk assistance. How may I help you today?"
  )
  // Configure for Twilio Media Streams
  .twilio({
    port: PORT,
    path: "/media",
    webhookPath: "/voice",
    streamUrl: `wss://${PUBLIC_DOMAIN}/media`,
    greeting: "Thank you for calling the Grand Hotel. Connecting you to our virtual front desk assistant.",
  });

// 2. Start the Twilio telephony server
const agent = await phoneAgent.listenTwilio({
  port: PORT,
  path: "/media",
  webhookPath: "/voice",
  streamUrl: `wss://${PUBLIC_DOMAIN}/media`,
});

console.log("\n========================================================");
console.log(`📞 Felona Voice Twilio Telephony Server Ready!`);
console.log(`   - Inbound Webhook URL: http://${PUBLIC_DOMAIN}/voice`);
console.log(`   - Media Stream URL:    ws://${PUBLIC_DOMAIN}/media`);
console.log("========================================================\n");

// 3. Optional: Trigger an outbound phone call if configured
if (process.env.TRIGGER_OUTBOUND_TO && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
  console.log(`Initiating outbound call to ${process.env.TRIGGER_OUTBOUND_TO}...`);
  const callResult = await makeTwilioCall({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
    to: process.env.TRIGGER_OUTBOUND_TO,
    streamUrl: `wss://${PUBLIC_DOMAIN}/media`,
    customParameters: {
      campaign: "welcome_call",
    },
  });
  console.log(`Outbound call dispatched! Call SID: ${callResult.callSid}, Status: ${callResult.status}`);
}
