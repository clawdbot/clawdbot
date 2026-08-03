// Qqbot plugin module implements outbound reply behavior.
import { debugLog } from "../utils/log.js";
import { ReplyLimiter, type ReplyLimitResult } from "./reply-limiter.js";

const replyLimiter = new ReplyLimiter();

export type { ReplyLimitResult };

export const MESSAGE_REPLY_LIMIT = 5;

export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  return replyLimiter.checkLimit(messageId);
}

export function recordMessageReply(messageId: string): void {
  replyLimiter.record(messageId);
  debugLog(
    `[qqbot] recordMessageReply: ${messageId}, count=${replyLimiter.getStats().totalReplies}`,
  );
}

/** Reserve one slot before a passive request so concurrent sends share one budget. */
export function claimMessageReply(messageId: string, reserve = 0): ReplyLimitResult {
  const result = replyLimiter.claim(messageId, reserve);
  if (result.allowed) {
    debugLog(
      `[qqbot] claimMessageReply: ${messageId}, remaining=${result.remaining}/${MESSAGE_REPLY_LIMIT}`,
    );
  }
  return result;
}

export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  return replyLimiter.getStats();
}

export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return replyLimiter.getConfig();
}
