import type { ActionContext, AgentAction } from "../types.js";
import { SlotCollector, type SlotDefinition } from "./collector.js";

/**
 * Prebuilt slot-collection tasks.
 *
 * These are the flows every call centre ends up building: confirm a name, take
 * an email, read back a card number. Written as agent actions so JEV routes to
 * them by description like any other action, and the handler's return value is
 * the next thing the agent says.
 *
 * Each factory returns a fresh collector per call, so concurrent sessions never
 * share collected state.
 */

export interface CollectTaskOptions {
  /** Action id. Defaults to the task name. */
  id?: string;
  /** Description JEV embeds to route here. Auto-generated if omitted. */
  description?: string;
  /** Slots to collect, in the order they should be asked. */
  slots: SlotDefinition[];
  /**
   * What to say once everything is collected. Receives the collected values.
   * Default: a generic confirmation.
   */
  onComplete?: (slots: Record<string, unknown>) => string;
  /**
   * Said when the caller gives up partway. Receives whatever was collected.
   * Default: a graceful acknowledgement.
   */
  onIncomplete?: (slots: Record<string, unknown>, missing: string[]) => string;
  /**
   * What the caller says to start. When set, the action opens the flow with
   * this prompt rather than waiting to be routed to.
   */
  greeting?: string;
}

const DEFAULT_COMPLETION: Record<string, string> = {
  name: "Thank you",
  email: "Thank you",
  phone: "Thank you",
  zip: "Thank you",
  address: "Thank you",
  cardNumber: "Thank you",
  expiry: "Thank you",
  cvv: "Thank you",
  number: "Thank you",
  date: "Thank you",
  string: "Thank you",
};

/**
 * Build an action that walks the caller through collecting a set of slots.
 */
export function createCollectTask(options: CollectTaskOptions): AgentAction {
  const { slots, greeting, id = "collect" } = options;

  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error("createCollectTask requires at least one slot definition");
  }

  // Describing the fields makes JEV far more likely to route here for the right
  // reason than a generic "collect" description would.
  const fieldList = slots
    .map((slot) => slot.name.replace(/_/g, " "))
    .join(", ");

  const description =
    options.description ??
    `Collect ${fieldList} from the caller. Use when you need their ${fieldList}.`;

  return {
    id,
    description,
    handler: async (ctx: ActionContext) => runCollectTask(options, ctx, greeting),
  };
}

/**
 * Shared handler body.
 *
 * Exported separately so an existing hand-written action can adopt the same
 * collection behaviour.
 */
export async function runCollectTask(
  options: CollectTaskOptions,
  ctx: ActionContext,
  greeting?: string,
): Promise<string> {
  const collector = resolveCollector(options, ctx);

  // Opening the flow: ask for the first field.
  const opening = collector.nextPrompt();
  if (greeting && opening) {
    return `${greeting} ${opening}`;
  }
  if (opening) return opening;

  return completeMessage(options, collector);
}

/**
 * Continue an in-progress collection.
 *
 * Feed it the caller's reply; it returns the next prompt or a closing line.
 */
export function continueCollectTask(
  options: CollectTaskOptions,
  collector: SlotCollector,
  reply: string,
): string {
  const result = collector.ingest(reply);

  if (result.complete) {
    return completeMessage(options, collector);
  }

  // A rejected value gets a targeted re-ask before falling back to the next
  // field, so the caller is not asked something they just failed to answer.
  if (result.rejected.length > 0) {
    return result.rejected[0].message;
  }

  if (result.prompt) return result.prompt;
  return completeMessage(options, collector);
}

function completeMessage(
  options: CollectTaskOptions,
  collector: SlotCollector,
): string {
  const slots = collector.slots;
  if (options.onComplete) return options.onComplete(slots);
  if (options.onIncomplete && collector.missing.length > 0) {
    return options.onIncomplete(slots, collector.missing);
  }
  const thanks = DEFAULT_COMPLETION[collector.state[0]?.type ?? "string"];
  return `${thanks}, ${summarize(slots)}.`;
}

function summarize(slots: Record<string, unknown>): string {
  const entries = Object.entries(slots);
  if (entries.length === 0) return "I have everything I need";
  return entries
    .map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`)
    .join(", ");
}

/**
 * One collector per session, stored in the agent's in-memory session slots.
 *
 * Keeping it on the session (rather than a closure) is what makes the
 * collection survive across turns without ever being written to disk.
 */
const COLLECTOR_KEY = "__felona_slot_collectors";

function resolveCollector(
  options: CollectTaskOptions,
  ctx: ActionContext,
): SlotCollector {
  const memory = ctx.memory;
  const stored = memory.getSlot(COLLECTOR_KEY) as
    | Record<string, SlotCollector>
    | undefined;

  const registry = stored ?? {};
  const existing = registry[options.id ?? "collect"];
  if (existing) return existing;

  const collector = new SlotCollector(options.slots);
  registry[options.id ?? "collect"] = collector;
  memory.setSlot(COLLECTOR_KEY, registry);
  return collector;
}

/** Get the live collector for a task in this session, if one exists. */
export function getTaskCollector(
  ctx: ActionContext,
  taskId: string,
): SlotCollector | undefined {
  const registry = ctx.memory.getSlot(COLLECTOR_KEY) as
    | Record<string, SlotCollector>
    | undefined;
  return registry?.[taskId];
}

/** Discard a task's collected state. */
export function resetTaskCollector(ctx: ActionContext, taskId: string): void {
  const registry = ctx.memory.getSlot(COLLECTOR_KEY) as
    | Record<string, SlotCollector>
    | undefined;
  registry?.[taskId]?.reset();
}

// ─── Ready-made task factories ─────────────────────────────────────────────

/** Collect a caller's name. */
export function getNameTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_name",
    description:
      "Collect the caller's name. Use when you need to know who you are speaking with, " +
      "to personalize the call, or to address them directly.",
    slots: [
      {
        name: "name",
        type: "name",
        prompt: "May I ask who I'm speaking with?",
      },
    ],
    ...options,
  });
}

/**
 * Collect an email address.
 *
 * Speaks prompts in the "at ... dot ..." style the recognizer actually hears
 * correctly — asking someone to spell an address aloud rarely works.
 */
export function getEmailTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_email",
    description:
      "Collect the caller's email address. Use to send a confirmation, receipt, " +
      "or follow-up, or when you need to email them something.",
    slots: [
      {
        name: "email",
        type: "email",
        prompt:
          "What is the best email address for you? " +
          "You can say it as 'name at domain dot com'.",
      },
    ],
    ...options,
  });
}

/** Collect a phone number. */
export function getPhoneNumberTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_phone",
    description:
      "Collect a phone number. Use to call the caller back, send an SMS, or " +
      "confirm their contact details.",
    slots: [
      {
        name: "phone",
        type: "phone",
        prompt: "What is the best phone number to reach you on?",
      },
    ],
    ...options,
  });
}

/** Collect a mailing address. */
export function getAddressTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_address",
    description:
      "Collect a mailing or shipping address. Use when you need to send " +
      "something physical to the caller.",
    slots: [
      {
        name: "address",
        type: "address",
        prompt: "What is the shipping address?",
      },
    ],
    ...options,
  });
}

/** Collect a date of birth. */
export function getDateOfBirthTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_dob",
    description:
      "Collect a date of birth. Use to verify identity, check age eligibility, " +
      "or tailor the conversation.",
    slots: [
      {
        name: "date_of_birth",
        type: "date",
        prompt: "Can you tell me your date of birth?",
      },
    ],
    ...options,
  });
}

/** Collect a ZIP code. */
export function getZipCodeTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_zip",
    description:
      "Collect a ZIP code. Use to check delivery areas, shipping, or verify " +
      "the caller's location.",
    slots: [
      {
        name: "zip",
        type: "zip",
        prompt: "What is your ZIP code?",
      },
    ],
    ...options,
  });
}

/**
 * Collect full card details.
 *
 * A card is the hardest thing to collect by voice: the number is long, digits
 * get misheard, and asking for the CVV aloud is something many agents should
 * not do at all. The prompt therefore walks the number in groups, and the
 * Luhn check catches the mishear before it reaches a payment processor.
 */
export function getCreditCardTask(
  options: Partial<CollectTaskOptions> = {},
): AgentAction {
  return createCollectTask({
    id: "get_credit_card",
    description:
      "Collect credit card details for a payment. Use only when the caller " +
      "has asked to pay by card on this call.",
    slots: [
      {
        name: "cardNumber",
        type: "cardNumber",
        prompt:
          "I will read the card number back for you to confirm. " +
          "The number is 16 digits — are you ready?",
      },
      {
        name: "expiry",
        type: "expiry",
        prompt: "And what is the expiration month and year?",
      },
      {
        name: "cvv",
        type: "cvv",
        prompt: "Finally, the 3-digit security code on the back.",
      },
    ],
    ...options,
  });
}
