/**
 * Loaded-plugin session thread info resolver.
 *
 * Uses only already loaded channel hooks to resolve thread suffix metadata on hot paths.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
  type ParsedThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded.js";

type SessionConversationHookResult = {
  id: string;
  threadId?: string | null;
};

function resolveLoadedSessionConversationThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }
  const rawId = raw.rawId.trim();
  if (!rawId) {
    return null;
  }
  const messaging = getLoadedChannelPluginForRead(raw.channel)?.messaging;
  const resolved = messaging?.resolveSessionConversation?.({
    kind: raw.kind,
    rawId,
  }) as SessionConversationHookResult | null | undefined;
  if (!resolved?.id?.trim()) {
    return null;
  }
  // Loaded-plugin read paths avoid bundled fallback/materialization; if the
  // channel hook has no thread id, preserve the original session key.
  const id = resolved.id.trim();
  const threadId = normalizeOptionalString(resolved.threadId);
  return {
    baseSessionKey: threadId ? `${raw.prefix}:${id}` : normalizeOptionalString(sessionKey),
    threadId,
  };
}

/**
 * Resolves thread suffix metadata using loaded plugin hooks or generic parsing.
 */
export function resolveLoadedSessionThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  return (
    resolveLoadedSessionConversationThreadInfo(sessionKey) ?? parseThreadSessionSuffix(sessionKey)
  );
}
