// Media-understanding scope helpers evaluate ordered channel/chat/session rules
// before media providers process attachments.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { MediaUnderstandingScopeConfig } from "../config/types.tools.js";

type MediaUnderstandingScopeDecision = "allow" | "deny";

function normalizeDecision(value?: string | null): MediaUnderstandingScopeDecision | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "allow") {
    return "allow";
  }
  if (normalized === "deny") {
    return "deny";
  }
  return undefined;
}

/** Normalizes channel/direct chat type aliases used by media-understanding scope rules. */
export function normalizeMediaUnderstandingChatType(raw?: string | null): string | undefined {
  return normalizeChatType(raw ?? undefined);
}

/** Evaluates ordered media-understanding scope rules against channel, chat type, and session key. */
export function resolveMediaUnderstandingScope(params: {
  scope?: MediaUnderstandingScopeConfig;
  sessionKey?: string;
  channel?: string;
  chatType?: string;
}): MediaUnderstandingScopeDecision {
  const scope = params.scope;
  if (!scope) {
    return "allow";
  }

  const channel = normalizeOptionalLowercaseString(params.channel);
  const chatType = normalizeMediaUnderstandingChatType(params.chatType);
  const sessionKey = normalizeOptionalLowercaseString(params.sessionKey) ?? "";

  for (const rule of scope.rules ?? []) {
    // Rules are first-match-wins so operators can place specific denials before
    // broader default allow rules.
    if (!rule) {
      continue;
    }
    const action = normalizeDecision(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchChannel = normalizeOptionalLowercaseString(match.channel);
    const matchChatType = normalizeMediaUnderstandingChatType(match.chatType);
    const matchPrefix = normalizeOptionalLowercaseString(match.keyPrefix);

    if (matchChannel && matchChannel !== channel) {
      continue;
    }
    if (matchChatType && matchChatType !== chatType) {
      continue;
    }
    if (matchPrefix && !sessionKey.startsWith(matchPrefix)) {
      continue;
    }
    return action;
  }

  return normalizeDecision(scope.default) ?? "allow";
}
