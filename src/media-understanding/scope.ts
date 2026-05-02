import { normalizeChatType } from "../channels/chat-type.js";
import type { MediaUnderstandingScopeConfig } from "../config/types.tools.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

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

export function normalizeMediaUnderstandingChatType(raw?: string | null): string | undefined {
  return normalizeChatType(raw ?? undefined);
}

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
