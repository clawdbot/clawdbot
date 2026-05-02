import type { ReplyPayload } from "./reply-payload.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

export const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
const HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY = "openclawHeartbeatResponse";

export const HEARTBEAT_TOOL_OUTCOMES = [
  "no_change",
  "progress",
  "done",
  "blocked",
  "needs_attention",
] as const;
type HeartbeatToolOutcome = (typeof HEARTBEAT_TOOL_OUTCOMES)[number];

export const HEARTBEAT_TOOL_PRIORITIES = ["low", "normal", "high"] as const;
type HeartbeatToolPriority = (typeof HEARTBEAT_TOOL_PRIORITIES)[number];

export type HeartbeatToolResponse = {
  outcome: HeartbeatToolOutcome;
  notify: boolean;
  summary: string;
  notificationText?: string;
  reason?: string;
  priority?: HeartbeatToolPriority;
  nextCheck?: string;
};

const OUTCOMES = new Set<string>(HEARTBEAT_TOOL_OUTCOMES);
const PRIORITIES = new Set<string>(HEARTBEAT_TOOL_PRIORITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringAlias(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readBooleanAlias(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export function normalizeHeartbeatToolResponse(value: unknown): HeartbeatToolResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const outcome = readString(value.outcome);
  const notify = readBooleanAlias(value, "notify");
  const summary = readString(value.summary);
  if (!outcome || !OUTCOMES.has(outcome) || notify === undefined || !summary) {
    return undefined;
  }

  const priority = readString(value.priority);
  const notificationText = readStringAlias(value, "notificationText", "notification_text");
  const reason = readString(value.reason);
  const nextCheck = readStringAlias(value, "nextCheck", "next_check");
  return {
    outcome: outcome as HeartbeatToolOutcome,
    notify,
    summary,
    ...(notificationText ? { notificationText } : {}),
    ...(reason ? { reason } : {}),
    ...(priority && PRIORITIES.has(priority)
      ? { priority: priority as HeartbeatToolPriority }
      : {}),
    ...(nextCheck ? { nextCheck } : {}),
  };
}

export function getHeartbeatToolNotificationText(response: HeartbeatToolResponse): string {
  return response.notify ? (response.notificationText ?? response.summary).trim() : "";
}

export function createHeartbeatToolResponsePayload(response: HeartbeatToolResponse): ReplyPayload {
  return {
    text: response.notify ? getHeartbeatToolNotificationText(response) : HEARTBEAT_TOKEN,
    channelData: {
      [HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY]: response,
    },
  };
}

function getHeartbeatToolResponseFromPayload(
  payload: ReplyPayload | undefined,
): HeartbeatToolResponse | undefined {
  return normalizeHeartbeatToolResponse(
    payload?.channelData?.[HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY],
  );
}

export function resolveHeartbeatToolResponseFromReplyResult(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): HeartbeatToolResponse | undefined {
  if (!replyResult) {
    return undefined;
  }
  const payloads = Array.isArray(replyResult) ? replyResult : [replyResult];
  for (let idx = payloads.length - 1; idx >= 0; idx -= 1) {
    const response = getHeartbeatToolResponseFromPayload(payloads[idx]);
    if (response) {
      return response;
    }
  }
  return undefined;
}
