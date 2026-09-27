/**
 * Live call transfer.
 *
 * An agent that *says* it is escalating while doing nothing is worse than one
 * that cannot escalate, so this is a first-class capability rather than
 * something a caller wires up themselves.
 *
 * Two modes, matching what call centres actually mean by them:
 * - `cold` — hand the call over immediately. The caller gets a short goodbye
 *   and is redirected without context.
 * - `warm` — the agent first introduces the caller and the reason, then the
 *   call is redirected. The human (or the next agent) needs to know why they
 *   are receiving this call.
 */

export type TransferMode = "cold" | "warm";

export interface TransferRequest {
  /** `cold` hands over at once; `warm` lets the agent introduce the caller first. */
  mode?: TransferMode;
  /**
   * Destination in E.164 (`+15551234567`) or a SIP URI (`sip:agent@example.com`).
   */
  to: string;
  /**
   * Spoken to the caller before the handoff. For a warm transfer this is where
   * the agent summarises why the caller is being transferred.
   */
  message?: string;
  /**
   * Context handed to the receiving party — SIP headers for telephony, or
   * metadata for another agent. Values must be strings.
   */
  context?: Record<string, string>;
}

export interface TransferResult {
  success: boolean;
  mode: TransferMode;
  to: string;
  /** Provider-specific detail, e.g. the redirect TwiML that was applied. */
  detail?: string;
  /** Why the transfer could not be performed. */
  error?: string;
}

/**
 * Telephony-specific operations a transfer depends on.
 *
 * Separate from `Transport` because a transport moves audio, while this
 * manipulates the carrier's call state. Keeping them apart means a WebSocket
 * deployment can decline transfers explicitly rather than failing at runtime.
 */
export interface CallTransferProvider {
  readonly name: string;
  /** Whether this session's call can be redirected. */
  canTransfer(session: { id: string; metadata: Record<string, unknown> }): boolean;
  /**
   * Redirect a live call.
   *
   * Called after the transfer message has finished playing, so the caller hears
   * the whole thing before the line changes.
   */
  transfer(
    session: { id: string; metadata: Record<string, unknown> },
    request: Required<Pick<TransferRequest, "to">> & TransferRequest,
  ): Promise<TransferResult>;
  /** End the call. */
  hangup?(session: { id: string; metadata: Record<string, unknown> }): Promise<void>;
}

/** Escape a value for inclusion in XML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the TwiML that redirects a call already in progress.
 *
 * Twilio applies new TwiML to an active call through the Calls resource, which
 * is the only way to hand over a call that is already streaming audio to us.
 */
export function buildTransferTwiml(request: TransferRequest): string {
  const destination = escapeXml(request.to);
  const isSip = request.to.startsWith("sip:");

  const dialTarget = isSip ? destination : `<Number>${destination}</Number>`;

  const headers = Object.entries(request.context ?? {})
    .filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && typeof value === "string")
    .map(([key, value]) => `      <Parameter name="${escapeXml(key)}" value="${escapeXml(value)}" />`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Dial>",
    headers,
    `    ${dialTarget}`,
    "  </Dial>",
    "</Response>",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export interface TwilioTransferOptions {
  accountSid: string;
  authToken: string;
  /** Override the API base, for testing or regional endpoints. */
  baseUrl?: string;
}

/**
 * Twilio call transfer.
 *
 * Redirects an in-progress call by applying fresh TwiML to it. The call SID
 * comes from the session metadata captured when the media stream started, so no
 * extra wiring is needed on the caller's side.
 */
export class TwilioTransferProvider implements CallTransferProvider {
  readonly name = "twilio";
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;

  constructor(options: TwilioTransferOptions) {
    if (!options?.accountSid || !options?.authToken) {
      throw new Error(
        "TwilioTransferProvider requires accountSid and authToken. " +
          "Pass transfers: { accountSid, authToken } to the agent.",
      );
    }
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.baseUrl = options.baseUrl ?? "https://api.twilio.com/2010-04-01";
  }

  canTransfer(session: { id: string; metadata: Record<string, unknown> }): boolean {
    // Both are captured from the Media Streams "start" message.
    return Boolean(session.metadata?.callSid) && session.metadata?.telephony === "twilio";
  }

  async transfer(
    session: { id: string; metadata: Record<string, unknown> },
    request: TransferRequest,
  ): Promise<TransferResult> {
    const mode = request.mode ?? "cold";

    if (!request.to) {
      return { success: false, mode, to: request.to, error: "no destination provided" };
    }

    if (!this.canTransfer(session)) {
      return {
        success: false,
        mode,
        to: request.to,
        error: "this session is not a transferable Twilio call",
      };
    }

    const callSid = String(session.metadata.callSid);
    const twiml = buildTransferTwiml(request);

    const url = `${this.baseUrl}/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Twiml: twiml }).toString(),
      });

      if (!response.ok) {
        const detail = await response.text();
        return {
          success: false,
          mode,
          to: request.to,
          error: `Twilio rejected the transfer (${response.status}): ${detail.slice(0, 200)}`,
        };
      }

      return { success: true, mode, to: request.to, detail: twiml };
    } catch (error) {
      return {
        success: false,
        mode,
        to: request.to,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async hangup(session: { id: string; metadata: Record<string, unknown> }): Promise<void> {
    const callSid = session.metadata?.callSid;
    if (!callSid) return;

    const url = `${this.baseUrl}/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(String(callSid))}.json`;
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Status: "completed" }).toString(),
    });
  }
}

export function createTwilioTransferProvider(
  options: TwilioTransferOptions,
): TwilioTransferProvider {
  return new TwilioTransferProvider(options);
}
