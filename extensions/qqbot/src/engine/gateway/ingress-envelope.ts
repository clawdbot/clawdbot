// QQBot plugin module validates raw gateway envelopes for durable ingress.
import { GatewayEvent, GatewayOp } from "./constants.js";
import type { WSPayload } from "./types.js";

const QQBOT_TURN_EVENT_TYPES = new Set<string>([
  GatewayEvent.C2C_MESSAGE_CREATE,
  GatewayEvent.AT_MESSAGE_CREATE,
  GatewayEvent.DIRECT_MESSAGE_CREATE,
  GatewayEvent.GROUP_AT_MESSAGE_CREATE,
  GatewayEvent.GROUP_MESSAGE_CREATE,
]);

export class QQBotIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QQBotIngressPayloadError";
  }
}

type QQBotIngressEnvelopeFacts = {
  eventId: string;
  eventType: string;
  laneKey: string;
  payload: WSPayload;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QQBotIngressPayloadError(`QQBot gateway event is missing ${field}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const normalized = nonEmptyString(value);
  if (!normalized) {
    throw new QQBotIngressPayloadError(`QQBot gateway event is missing ${field}.`);
  }
  return normalized;
}

function parseRawEnvelope(rawEnvelope: string): WSPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvelope);
  } catch (error) {
    throw new QQBotIngressPayloadError("QQBot gateway envelope contains invalid JSON.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QQBotIngressPayloadError("QQBot gateway envelope must be an object.");
  }
  return parsed as WSPayload;
}

export function isQQBotTurnEventType(eventType: string | undefined): boolean {
  return eventType !== undefined && QQBOT_TURN_EVENT_TYPES.has(eventType);
}

export function inspectQQBotIngressEnvelope(rawEnvelope: string): QQBotIngressEnvelopeFacts | null {
  const payload = parseRawEnvelope(rawEnvelope);
  if (payload.op !== GatewayOp.DISPATCH || !isQQBotTurnEventType(payload.t)) {
    return null;
  }
  const eventType = requiredString(payload.t, "t");
  const data = record(payload.d, "d");
  // Message id, not the outer delivery id: QQ can expose one logical group
  // post through the @ and full-message create variants with distinct envelope
  // ids. Both variants carry the same stable data.id.
  const eventId = `message:${requiredString(data.id, "d.id")}`;

  if (eventType === GatewayEvent.C2C_MESSAGE_CREATE) {
    const author = record(data.author, "d.author");
    return {
      eventId,
      eventType,
      laneKey: `user:${requiredString(author.user_openid, "d.author.user_openid")}`,
      payload,
    };
  }
  if (eventType === GatewayEvent.AT_MESSAGE_CREATE) {
    return {
      eventId,
      eventType,
      laneKey: `channel:${requiredString(data.channel_id, "d.channel_id")}`,
      payload,
    };
  }
  if (eventType === GatewayEvent.DIRECT_MESSAGE_CREATE) {
    const author = record(data.author, "d.author");
    return {
      eventId,
      eventType,
      laneKey: `user:${requiredString(author.id, "d.author.id")}`,
      payload,
    };
  }
  const author = record(data.author, "d.author");
  requiredString(author.member_openid, "d.author.member_openid");
  return {
    eventId,
    eventType,
    laneKey: `group:${requiredString(data.group_openid, "d.group_openid")}`,
    payload,
  };
}
