import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { resolveLoadedSessionThreadInfo } from "../../channels/plugins/session-thread-info-loaded.js";

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
  return resolveLoadedSessionThreadInfo(sessionKey);
}
