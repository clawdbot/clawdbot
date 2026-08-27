// Line plugin module owns the durable webhook spool row contract.
import {
  isRecord,
  normalizeNullableString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

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

/** Defined locally (not via createChannelIngressError) because this module sits
 *  in the doctor contract closure, which must stay off the channel-outbound
 *  runtime barrel; the spool's permanent-failure classifier matches by class. */
export class LineWebhookPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LineWebhookPayloadError";
  }
}

/** Message ids preserve the shipped replay-guard keyspace; other events use LINE's delivery id. */
export function eventIdFor(event: unknown): string {
  if (!isRecord(event)) {
    throw new LineWebhookPayloadError("LINE webhook event must be an object.");
  }
  if (event.type === "message") {
    const message = isRecord(event.message) ? event.message : undefined;
    const messageId = nonEmptyString(message?.id);
    if (messageId) {
      return `message:${messageId}`;
    }
  }
  const webhookEventId = nonEmptyString(event.webhookEventId);
  if (webhookEventId) {
    return `event:${webhookEventId}`;
  }
  throw new LineWebhookPayloadError("LINE webhook event is missing a stable delivery id.");
}

/** Pre-drain (#109655) rows were keyed by the raw webhookEventId, before the
 *  message:/event: keyspace. The upgrade migration uses this prior derivation as its
 *  identity fence so a genuinely changed event still dead-letters. */
export function legacyEventIdFor(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  return nonEmptyString(event.webhookEventId);
}

export function laneKeyFor(event: unknown, eventId: string): string {
  if (!isRecord(event)) {
    return eventId;
  }
  const source = isRecord(event.source) ? event.source : undefined;
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
