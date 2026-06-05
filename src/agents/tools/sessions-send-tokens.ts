/**
 * sessions_send sentinel tokens.
 *
 * Defines non-deliverable reply markers used by sessions_send and subagent completion delivery.
 */
import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

/** Suppresses a subagent completion announcement. */
export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
/** Suppresses a direct reply delivery. */
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";

const NON_DELIVERABLE_REPLY_TOKENS = [
  ANNOUNCE_SKIP_TOKEN,
  REPLY_SKIP_TOKEN,
  SILENT_REPLY_TOKEN,
  HEARTBEAT_TOKEN,
] as const;

/** Returns true when text is exactly the announce-skip sentinel. */
export function isAnnounceSkip(text?: string) {
  return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}

/** Returns true when text is exactly the reply-skip sentinel. */
export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}

/** Returns true when text is any non-deliverable sessions reply sentinel. */
export function isNonDeliverableSessionsReply(text?: string) {
  return NON_DELIVERABLE_REPLY_TOKENS.some((token) => isSilentReplyText(text, token));
}
