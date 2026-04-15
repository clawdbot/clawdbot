import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { parseDiscordTarget } from "./target-parsing.js";

function normalizeDiscordTarget(
  raw: string | null | undefined,
  defaultKind: "user" | "channel",
): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  return parseDiscordTarget(trimmed, { defaultKind })?.normalized;
}

function buildDiscordConversationIdentity(
  kind: "user" | "channel",
  rawId: string | null | undefined,
): string | undefined {
  const trimmed = normalizeOptionalString(rawId);
  return trimmed ? `${kind}:${trimmed}` : undefined;
}

export function resolveDiscordConversationIdentity(params: {
  isDirectMessage: boolean;
  userId?: string | null;
  channelId?: string | null;
}): string | undefined {
  return params.isDirectMessage
    ? buildDiscordConversationIdentity("user", params.userId)
    : buildDiscordConversationIdentity("channel", params.channelId);
}

export function resolveDiscordCurrentConversationIdentity(params: {
  chatType?: string | null;
  from?: string | null;
  originatingTo?: string | null;
  commandTo?: string | null;
  fallbackTo?: string | null;
}): string | undefined {
  if (normalizeOptionalLowercaseString(params.chatType) === "direct") {
    const senderTarget = normalizeDiscordTarget(params.from, "user");
    if (senderTarget?.startsWith("user:")) {
      return senderTarget;
    }
  }

  for (const candidate of [params.originatingTo, params.commandTo, params.fallbackTo]) {
    const target = normalizeDiscordTarget(candidate, "channel");
    if (target) {
      return target;
    }
  }

  return undefined;
}
