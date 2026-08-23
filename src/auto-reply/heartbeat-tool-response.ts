// Structured heartbeat response tool payload helpers.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import type { ReplyPayload } from "./reply-payload.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

/** Tool name used by heartbeat runs to report visible or silent progress. */
export const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
const HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY = "openclawHeartbeatResponse";
const HEARTBEAT_SCRATCH_PROPOSAL = Symbol("openclawHeartbeatScratchProposal");
type HeartbeatReplyPayload = ReplyPayload & { [HEARTBEAT_SCRATCH_PROPOSAL]?: string };

/** Allowed heartbeat response outcomes. */
export const HEARTBEAT_TOOL_OUTCOMES = [
  "no_change",
  "progress",
  "done",
  "blocked",
  "needs_attention",
] as const;
type HeartbeatToolOutcome = (typeof HEARTBEAT_TOOL_OUTCOMES)[number];

/** Allowed heartbeat notification priorities. */
export const HEARTBEAT_TOOL_PRIORITIES = ["low", "normal", "high"] as const;
type HeartbeatToolPriority = (typeof HEARTBEAT_TOOL_PRIORITIES)[number];

/** Normalized response emitted by the heartbeat response tool. */
export type HeartbeatToolResponse = {
  outcome: HeartbeatToolOutcome;
  notify: boolean;
  summary: string;
  notificationText?: string;
  reason?: string;
  priority?: HeartbeatToolPriority;
  nextCheck?: string;
  /** Complete replacement for the current heartbeat monitor's private scratch. */
  scratch?: string;
};

const OUTCOMES = new Set<string>(HEARTBEAT_TOOL_OUTCOMES);
const PRIORITIES = new Set<string>(HEARTBEAT_TOOL_PRIORITIES);

function readBooleanAlias(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

/** Validate and normalize unknown heartbeat tool output. */
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
  const notificationText = readTrimmedStringAlias(value, ["notificationText", "notification_text"]);
  const reason = readString(value.reason);
  const nextCheck = readTrimmedStringAlias(value, ["nextCheck", "next_check"]);
  const scratch = typeof value.scratch === "string" ? value.scratch : undefined;
  if (scratch !== undefined) {
    try {
      assertCronJobScratchContent(scratch);
    } catch {
      return undefined;
    }
  }
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
    ...(scratch !== undefined ? { scratch } : {}),
  };
}

/** Resolve the user-visible notification text for a heartbeat response. */
export function getHeartbeatToolNotificationText(response: HeartbeatToolResponse): string {
  return response.notify ? (response.notificationText ?? response.summary).trim() : "";
}

/** Store public heartbeat response metadata while keeping scratch process-private. */
export function createHeartbeatToolResponsePayload(
  response: HeartbeatToolResponse,
): HeartbeatReplyPayload {
  const { scratch, ...publicResponse } = response;
  const payload: HeartbeatReplyPayload = {
    text: response.notify ? getHeartbeatToolNotificationText(response) : HEARTBEAT_TOKEN,
    channelData: {
      [HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY]: publicResponse,
    },
  };
  if (scratch !== undefined) {
    Object.defineProperty(payload, HEARTBEAT_SCRATCH_PROPOSAL, {
      value: scratch,
      enumerable: false,
    });
  }
  return payload;
}

function getHeartbeatToolResponseFromPayload(
  payload: ReplyPayload | undefined,
): HeartbeatToolResponse | undefined {
  return normalizeHeartbeatToolResponse(
    payload?.channelData?.[HEARTBEAT_RESPONSE_CHANNEL_DATA_KEY],
  );
}

/** Find the last heartbeat tool response embedded in a reply result. */
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

/** Reads the non-serializable scratch proposal captured for the heartbeat turn. */
export function resolveHeartbeatScratchProposalFromReplyResult(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): string | undefined {
  if (!replyResult) {
    return undefined;
  }
  const payloads = Array.isArray(replyResult) ? replyResult : [replyResult];
  for (let idx = payloads.length - 1; idx >= 0; idx -= 1) {
    const payload = payloads[idx];
    // Anchor to the newest heartbeat-response payload: a later corrected
    // response without scratch must supersede an earlier scratch proposal,
    // so the scan stops at the first response payload either way.
    if (!getHeartbeatToolResponseFromPayload(payload)) {
      continue;
    }
    return (payload as HeartbeatReplyPayload | undefined)?.[HEARTBEAT_SCRATCH_PROPOSAL];
  }
  return undefined;
}
