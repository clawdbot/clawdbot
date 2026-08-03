// Voice Call plugin module implements twiml policy behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebhookContext } from "../../types.js";

// Twilio webhook policy for deciding whether to stream, pause, queue, or serve stored TwiML.

/** Normalized Twilio webhook request fields used by TwiML policy. */
type TwimlRequestView = {
  callStatus: string | null;
  direction: string | null;
  isStatusCallback: boolean;
  callSid?: string;
  callIdFromQuery?: string;
};

/** Full TwiML policy input including manager/runtime state. */
type TwimlPolicyInput = TwimlRequestView & {
  hasStoredTwiml: boolean;
  isNotifyCall: boolean;
  hasActiveStreams: boolean;
  canStream: boolean;
};

/** TwiML response decision plus side effects the caller should apply. */
type TwimlDecision =
  | {
      kind: "empty" | "pause" | "queue";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stored";
      consumeStoredTwimlCallId: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stream";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    };

/** Return true for Twilio outbound call directions. */
function isOutboundDirection(direction: string | null): boolean {
  return direction?.startsWith("outbound") ?? false;
}

/** Read the Twilio request fields needed by TwiML decision logic. */
export function readTwimlRequestView(ctx: WebhookContext): TwimlRequestView {
  const params = new URLSearchParams(ctx.rawBody);
  const type = normalizeOptionalString(ctx.query?.type);
  const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);

  return {
    callStatus: params.get("CallStatus"),
    direction: params.get("Direction"),
    isStatusCallback: type === "status",
    callSid: params.get("CallSid") || undefined,
    callIdFromQuery,
  };
}

/** Decide the TwiML response kind for a Twilio webhook request. */
export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      return { kind: "stored", consumeStoredTwimlCallId: input.callIdFromQuery };
    }
    if (input.isNotifyCall) {
      return { kind: "empty" };
    }

    if (isOutboundDirection(input.direction)) {
      return input.canStream ? { kind: "stream" } : { kind: "pause" };
    }
  }

  if (input.isStatusCallback) {
    return { kind: "empty" };
  }

  if (input.direction === "inbound") {
    if (input.hasActiveStreams) {
      return { kind: "queue" };
    }
    if (input.canStream && input.callSid) {
      return { kind: "stream", activateStreamCallSid: input.callSid };
    }
    return { kind: "pause" };
  }

  if (input.callStatus !== "in-progress") {
    return { kind: "empty" };
  }

  return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
