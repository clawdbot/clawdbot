import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  return resolveSessionThreadInfo(sessionKey);
}

export function parseSessionThreadInfoFast(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  return resolveSessionThreadInfo(sessionKey, { bundledFallback: false });
}
