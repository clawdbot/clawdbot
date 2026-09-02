// Slack plugin module implements thread ts behavior.
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SLACK_THREAD_TS_PATTERN = /^\d+\.\d+$/;

export function resolveSlackReplyThreadTs(params: {
  replyToId?: string;
  threadId?: string;
  replyToMode?: ReplyToMode;
  replyToIsExplicit?: boolean;
  replyToCurrent?: boolean;
}): string | undefined {
  const replyToId = params.replyToMode === "off" ? undefined : params.replyToId;
  // Slack requires the root timestamp, not the current child. Only current or
  // known inherited replies may replace an explicit target with that root.
  return params.replyToCurrent || params.replyToIsExplicit === false
    ? (params.threadId ?? replyToId)
    : (replyToId ?? params.threadId);
}

export function normalizeSlackThreadTsCandidate(
  value?: string | number | null,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalString(value);
  return normalized && SLACK_THREAD_TS_PATTERN.test(normalized) ? normalized : undefined;
}

export function resolveSlackThreadTsValue(params: {
  replyToId?: string | number | null;
  threadId?: string | number | null;
}): string | undefined {
  return (
    normalizeSlackThreadTsCandidate(params.replyToId) ??
    normalizeSlackThreadTsCandidate(params.threadId)
  );
}
