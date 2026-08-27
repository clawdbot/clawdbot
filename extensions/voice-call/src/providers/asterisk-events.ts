import { z } from "zod";
import type { EndReason, NormalizedEvent } from "../types.js";

const AriChannelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    state: z.string().optional(),
    caller: z.object({ number: z.string().optional() }).passthrough().optional(),
    connected: z.object({ number: z.string().optional() }).passthrough().optional(),
    dialplan: z.object({ exten: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const AriEventSchema = z
  .object({
    application: z.string().optional(),
    args: z.array(z.string()).optional(),
    cause: z.number().optional(),
    cause_txt: z.string().optional(),
    channel: AriChannelSchema.optional(),
    dialstatus: z.string().optional(),
    digit: z.string().optional(),
    peer: AriChannelSchema.optional(),
    timestamp: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export type AriChannel = z.infer<typeof AriChannelSchema>;
export type AriEvent = z.infer<typeof AriEventSchema>;

export type AsteriskCallMetadata = {
  callId: string;
  providerCallId: string;
  direction: "inbound" | "outbound";
  from?: string;
  to?: string;
};

export type AsteriskEventDetails =
  | { type: "call.initiated" | "call.ringing" | "call.answered" }
  | { type: "call.dtmf"; digits: string }
  | { type: "call.ended"; reason: EndReason }
  | { type: "call.error"; error: string; retryable: boolean };

export function parseAsteriskAriEvent(raw: Buffer): AriEvent {
  try {
    return AriEventSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch (cause) {
    throw new Error("Asterisk ARI event was malformed", { cause });
  }
}

export function mapAsteriskHangupCause(cause: number | undefined): EndReason {
  switch (cause) {
    case 16:
      return "completed";
    case 17:
      return "busy";
    case 18:
    case 19:
      return "no-answer";
    case 21:
      return "hangup-user";
    case 1:
    case 3:
    case 27:
    case 34:
    case 38:
    case 41:
    case 42:
    case 44:
    case 47:
    case 58:
      return "failed";
    default:
      return cause === undefined ? "completed" : "failed";
  }
}

export function normalizeAsteriskState(
  state: string | undefined,
): "call.ringing" | "call.answered" | "call.ended" | null {
  switch (state?.toLowerCase()) {
    case "ring":
    case "ringing":
    case "pre-ring":
      return "call.ringing";
    case "up":
      return "call.answered";
    case "busy":
      return "call.ended";
    default:
      return null;
  }
}

export function buildAsteriskNormalizedEvent(params: {
  metadata: AsteriskCallMetadata;
  event: AriEvent;
  details: AsteriskEventDetails;
}): NormalizedEvent {
  const { metadata, event, details } = params;
  const timestamp = event.timestamp ? Date.parse(event.timestamp) : Date.now();
  const eventTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const eventId = [
    "asterisk",
    details.type,
    metadata.providerCallId,
    event.timestamp ?? eventTimestamp,
    event.digit ?? "",
    event.dialstatus ?? "",
  ].join(":");
  return {
    id: eventId,
    dedupeKey: eventId,
    callId: metadata.callId,
    providerCallId: metadata.providerCallId,
    timestamp: eventTimestamp,
    direction: metadata.direction,
    from: metadata.from,
    to: metadata.to,
    ...details,
  };
}
