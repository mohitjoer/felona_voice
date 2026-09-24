/**
 * Telephony TwiML & Call Orchestration Helpers (Twilio & Telnyx)
 */

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface TwilioStreamTwiMLOptions {
  /**
   * The WebSocket URL Twilio will connect to (e.g. "wss://voice.mycompany.com/media").
   */
  streamUrl: string;

  /**
   * Optional introductory greeting spoken by Twilio before connecting the media stream.
   * e.g. "Connecting you to your AI assistant..."
   */
  greeting?: string;

  /**
   * Voice used for the introductory greeting (e.g. "Polly.Joanna-Neural", "alice").
   */
  greetingVoice?: string;

  /**
   * Custom metadata parameters forwarded to the media stream's "start" event.
   * Accessible in Felona Voice under `session.metadata.customParameters`.
   */
  customParameters?: Record<string, string>;

  /**
   * Optional status callback URL when the call status changes.
   */
  statusCallback?: string;

  /**
   * Stream direction: "inbound_track", "outbound_track", or "both_tracks" (default: "inbound_track").
   */
  track?: "inbound_track" | "outbound_track" | "both_tracks";
}

/**
 * Generate standard TwiML response connecting an incoming or outgoing Twilio call
 * directly to a Felona Voice Media Stream WebSocket.
 */
export function createTwilioStreamTwiML(options: TwilioStreamTwiMLOptions): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n`;

  if (options.greeting) {
    const voiceAttr = options.greetingVoice ? ` voice="${escapeXml(options.greetingVoice)}"` : "";
    xml += `  <Say${voiceAttr}>${escapeXml(options.greeting)}</Say>\n`;
  }

  const trackAttr = options.track ? ` track="${escapeXml(options.track)}"` : "";
  const statusAttr = options.statusCallback ? ` statusCallback="${escapeXml(options.statusCallback)}"` : "";

  xml += `  <Connect${statusAttr}>\n    <Stream url="${escapeXml(options.streamUrl)}"${trackAttr}>\n`;

  if (options.customParameters) {
    for (const [key, value] of Object.entries(options.customParameters)) {
      xml += `      <Parameter name="${escapeXml(key)}" value="${escapeXml(String(value))}" />\n`;
    }
  }

  xml += `    </Stream>\n  </Connect>\n</Response>`;
  return xml;
}

/**
 * Generate Telnyx TeXML response connecting a call to a media stream.
 */
export function createTelnyxStreamTeXML(options: TwilioStreamTwiMLOptions): string {
  return createTwilioStreamTwiML(options);
}

export interface TwilioOutboundCallOptions {
  /** Twilio Account SID (e.g. "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") */
  accountSid: string;
  /** Twilio Auth Token */
  authToken: string;
  /** Target phone number to call (E.164 format, e.g. "+15551234567") */
  to: string;
  /** Twilio phone number making the call (E.164 format) */
  from: string;
  /** WebSocket media stream URL (e.g. "wss://your-domain.com/media") */
  streamUrl: string;
  /** Optional pre-rendered TwiML. If omitted, generated automatically from streamUrl */
  twiml?: string;
  /** Optional custom parameters to pass to the stream session */
  customParameters?: Record<string, string>;
  /** Optional status callback URL */
  statusCallback?: string;
}

export interface TwilioCallResult {
  callSid: string;
  status: string;
  to: string;
  from: string;
  dateCreated: string;
}

/**
 * Make an outbound phone call via Twilio REST API without requiring external SDKs.
 * Automatically connects the answered mobile call to Felona Voice WebSocket stream.
 */
export async function makeTwilioCall(options: TwilioOutboundCallOptions): Promise<TwilioCallResult> {
  const twiml = options.twiml || createTwilioStreamTwiML({
    streamUrl: options.streamUrl,
    customParameters: options.customParameters,
    statusCallback: options.statusCallback,
  });

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Calls.json`;
  const credentials = Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64");

  const formData = new URLSearchParams();
  formData.append("To", options.to);
  formData.append("From", options.from);
  formData.append("Twiml", twiml);

  if (options.statusCallback) {
    formData.append("StatusCallback", options.statusCallback);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio call failed (${response.status} ${response.statusText}): ${errorText}`);
  }

  const data = (await response.json()) as {
    sid: string;
    status: string;
    to: string;
    from: string;
    date_created: string;
  };

  return {
    callSid: data.sid,
    status: data.status,
    to: data.to,
    from: data.from,
    dateCreated: data.date_created,
  };
}
