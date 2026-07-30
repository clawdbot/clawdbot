// Line plugin module owns the durable webhook spool row contract.
import { createChannelIngressError } from "openclaw/plugin-sdk/channel-outbound";
import { normalizeNullableString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const LINE_WEBHOOK_SPOOL_VERSION = 1;

/** Message the canonical decoder attaches when it rejects a spool payload. The
 *  upgrade migration matches this signature to recover rows the pre-fix decoder
 *  dead-lettered; the identity fence writes a different message on purpose. */
export const LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE = "LINE webhook spool payload is invalid.";

/** Dead-letter reason for undecodable events; shared so the migration's
 *  recovery signature can never drift from what the spool writes. */
export const LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON = "invalid-event";

export type LineWebhookSpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

export const LineWebhookPayloadError = createChannelIngressError("LineWebhookPayloadError");

/** Message ids preserve the shipped replay-guard keyspace; other events use LINE's delivery id. */
export function eventIdFor(event: unknown): string {
  if (!event || typeof event !== "object") {
    throw new LineWebhookPayloadError("LINE webhook event must be an object.");
  }
  const candidate = event as {
    type?: unknown;
    message?: { id?: unknown };
    webhookEventId?: unknown;
  };
  if (candidate.type === "message") {
    const messageId = nonEmptyString(candidate.message?.id);
    if (messageId) {
      return `message:${messageId}`;
    }
  }
  const webhookEventId = nonEmptyString(candidate.webhookEventId);
  if (webhookEventId) {
    return `event:${webhookEventId}`;
  }
  throw new LineWebhookPayloadError("LINE webhook event is missing a stable delivery id.");
}

/** Pre-drain (#109655) rows were keyed by the raw webhookEventId, before the
 *  message:/event: keyspace. The upgrade migration uses this prior derivation as its
 *  identity fence so a genuinely changed event still dead-letters. */
export function legacyEventIdFor(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  return nonEmptyString((event as { webhookEventId?: unknown }).webhookEventId);
}

export function laneKeyFor(event: unknown, eventId: string): string {
  if (!event || typeof event !== "object") {
    return eventId;
  }
  const source = (event as { source?: Record<string, unknown> }).source;
  if (source?.type === "group") {
    const groupId = nonEmptyString(source.groupId);
    if (groupId) {
      return `group:${groupId}`;
    }
  }
  if (source?.type === "room") {
    const roomId = nonEmptyString(source.roomId);
    if (roomId) {
      return `room:${roomId}`;
    }
  }
  if (source?.type === "user") {
    const userId = nonEmptyString(source.userId);
    if (userId) {
      return `user:${userId}`;
    }
  }
  return eventId;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
