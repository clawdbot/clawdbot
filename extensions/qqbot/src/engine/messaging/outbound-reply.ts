import { debugLog } from "../utils/log.js";
import { ReplyLimiter, type ReplyLimitResult } from "./reply-limiter.js";

const replyLimiter = new ReplyLimiter();

export type { ReplyLimitResult };

export const MESSAGE_REPLY_LIMIT = 4;

export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  return replyLimiter.checkLimit(messageId);
}

export function recordMessageReply(messageId: string): void {
  replyLimiter.record(messageId);
  debugLog(
    `[qqbot] recordMessageReply: ${messageId}, count=${replyLimiter.getStats().totalReplies}`,
  );
}

export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  return replyLimiter.getStats();
}

export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return replyLimiter.getConfig();
}
