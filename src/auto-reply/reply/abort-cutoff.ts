import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";

export type AbortCutoff = {
  messageSid?: string;
  timestamp?: number;
};

type SessionAbortCutoffEntry = Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">;

export function resolveAbortCutoffFromContext(ctx: MsgContext): AbortCutoff | undefined {
  const messageSid =
    normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid);
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  if (!messageSid && timestamp === undefined) {
    return undefined;
  }
  return { messageSid, timestamp };
}

export function readAbortCutoffFromSessionEntry(
  entry: SessionAbortCutoffEntry | undefined,
): AbortCutoff | undefined {
  if (!entry) {
    return undefined;
  }
  const messageSid = normalizeOptionalString(entry.abortCutoffMessageSid);
  const timestamp =
    typeof entry.abortCutoffTimestamp === "number" && Number.isFinite(entry.abortCutoffTimestamp)
      ? entry.abortCutoffTimestamp
      : undefined;
  if (!messageSid && timestamp === undefined) {
    return undefined;
  }
  return { messageSid, timestamp };
}

export function hasAbortCutoff(entry: SessionAbortCutoffEntry | undefined): boolean {
  return readAbortCutoffFromSessionEntry(entry) !== undefined;
}

export function applyAbortCutoffToSessionEntry(
  entry: SessionAbortCutoffEntry,
  cutoff: AbortCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}

function toNumericMessageSid(value: string | undefined): bigint | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return undefined;
  }
}

export function shouldSkipMessageByAbortCutoff(params: {
  cutoffMessageSid?: string;
  cutoffTimestamp?: number;
  messageSid?: string;
  timestamp?: number;
}): boolean {
  const cutoffSid = normalizeOptionalString(params.cutoffMessageSid);
  const currentSid = normalizeOptionalString(params.messageSid);
  if (cutoffSid && currentSid) {
    const cutoffNumeric = toNumericMessageSid(cutoffSid);
    const currentNumeric = toNumericMessageSid(currentSid);
    if (cutoffNumeric !== undefined && currentNumeric !== undefined) {
      return currentNumeric <= cutoffNumeric;
    }
    if (currentSid === cutoffSid) {
      return true;
    }
  }
  if (
    typeof params.cutoffTimestamp === "number" &&
    Number.isFinite(params.cutoffTimestamp) &&
    typeof params.timestamp === "number" &&
    Number.isFinite(params.timestamp)
  ) {
    return params.timestamp <= params.cutoffTimestamp;
  }
  return false;
}

export function shouldPersistAbortCutoff(params: {
  commandSessionKey?: string;
  targetSessionKey?: string;
}): boolean {
  const commandSessionKey = normalizeOptionalString(params.commandSessionKey);
  const targetSessionKey = normalizeOptionalString(params.targetSessionKey);
  if (!commandSessionKey || !targetSessionKey) {
    return true;
  }
  // Native targeted /stop can run from a slash/session-control key while the
  // actual target session uses different message id/timestamp spaces.
  // Persist cutoff only when command source and target are the same session.
  return commandSessionKey === targetSessionKey;
}
