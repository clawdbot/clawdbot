import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordCurrentConversationIdentity } from "./conversation-identity.js";
import { normalizeDiscordMessagingTarget } from "./normalize.js";
import { parseDiscordTarget } from "./target-parsing.js";

export function resolveDiscordAttachedOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  return threadId ? `channel:${threadId}` : params.to;
}

export function buildDiscordCrossContextPresentation(params: {
  originLabel: string;
  message: string;
}) {
  const trimmed = params.message.trim();
  return {
    tone: "neutral" as const,
    blocks: [
      ...(trimmed
        ? ([{ type: "text" as const, text: params.message }, { type: "divider" as const }] as const)
        : []),
      { type: "context" as const, text: `From ${params.originLabel}` },
    ],
  };
}

export function normalizeDiscordAcpConversationId(conversationId: string) {
  const normalized = conversationId.trim();
  return normalized ? { conversationId: normalized } : null;
}

export function matchDiscordAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  if (params.bindingConversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    params.bindingConversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function resolveDiscordConversationIdFromTargets(
  targets: Array<string | undefined>,
): string | undefined {
  for (const raw of targets) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const target = parseDiscordTarget(trimmed, { defaultKind: "channel" });
      if (target?.normalized) {
        return target.normalized;
      }
    } catch {
      const mentionMatch = trimmed.match(/^<#(\d+)>$/);
      if (mentionMatch?.[1]) {
        return `channel:${mentionMatch[1]}`;
      }
      if (/^\d{6,}$/.test(trimmed)) {
        return normalizeDiscordMessagingTarget(trimmed);
      }
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeLowercaseStringOrEmpty(raw);
  if (!sessionKey) {
    return undefined;
  }
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

export function resolveDiscordCommandConversation(params: {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  from?: string;
  chatType?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const targets = [params.originatingTo, params.commandTo, params.fallbackTo];
  if (params.threadId) {
    const parentConversationId =
      normalizeDiscordMessagingTarget(normalizeOptionalString(params.threadParentId) ?? "") ||
      parseDiscordParentChannelFromSessionKey(params.parentSessionKey) ||
      resolveDiscordConversationIdFromTargets(targets);
    return {
      conversationId: params.threadId,
      ...(parentConversationId && parentConversationId !== params.threadId
        ? { parentConversationId }
        : {}),
    };
  }
  const conversationId = resolveDiscordCurrentConversationIdentity({
    from: params.from,
    chatType: params.chatType,
    originatingTo: params.originatingTo,
    commandTo: params.commandTo,
    fallbackTo: params.fallbackTo,
  });
  return conversationId ? { conversationId } : null;
}

export function resolveDiscordInboundConversation(params: {
  from?: string;
  to?: string;
  conversationId?: string;
  isGroup: boolean;
}) {
  const conversationId = resolveDiscordCurrentConversationIdentity({
    from: params.from,
    chatType: params.isGroup ? "group" : "direct",
    originatingTo: params.to,
    fallbackTo: params.conversationId,
  });
  return conversationId ? { conversationId } : null;
}

export function parseDiscordExplicitTarget(raw: string) {
  try {
    const target = parseDiscordTarget(raw, { defaultKind: "channel" });
    if (!target) {
      return null;
    }
    return {
      to: target.normalized,
      chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
    };
  } catch {
    return null;
  }
}
