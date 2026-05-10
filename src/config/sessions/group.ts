import type { MsgContext } from "../../auto-reply/templating.js";
import { listChannelPlugins } from "../../channels/plugins/registry.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeHyphenSlug } from "../../shared/string-normalization.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

type LegacyGroupSessionSurface = {
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => GroupKeyResolution | null;
};

function resolveLegacyGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  for (const plugin of listChannelPlugins()) {
    const resolved = (
      plugin.messaging as LegacyGroupSessionSurface | undefined
    )?.resolveLegacyGroupSessionKey?.(ctx);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function normalizeGroupLabel(raw?: string) {
  return normalizeHyphenSlug(raw);
}

function resolveOriginatingGroupTargetId(params: {
  ctx: MsgContext;
  provider: string;
}): string | null {
  const target = normalizeOptionalString(params.ctx.OriginatingTo ?? params.ctx.To) ?? "";
  if (!target) {
    return null;
  }
  const parts = target.split(":").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const head = normalizeLowercaseStringOrEmpty(parts[0]);
  const second = normalizeOptionalLowercaseString(parts[1]);
  const secondIsKind = second === "group" || second === "channel";
  if (secondIsKind && (head === params.provider || getGroupSurfaces().has(head))) {
    return parts.slice(2).join(":") || null;
  }
  if (head === params.provider || head === "chat" || head === "room" || head === "group") {
    return parts.slice(1).join(":") || null;
  }
  if (head === "channel") {
    return parts.slice(1).join(":") || null;
  }
  return null;
}

function shortenGroupId(value?: string) {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = normalizeOptionalLowercaseString(params.provider) ?? "group";
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const space = normalizeOptionalString(params.space);
  const subject = normalizeOptionalString(params.subject);
  const detail =
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || "";
  const fallbackId = normalizeOptionalString(params.id) ?? params.key;
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = normalizeOptionalString(ctx.From) ?? "";
  const chatType = normalizeOptionalLowercaseString(ctx.ChatType);
  const normalizedChatType =
    chatType === "channel" ? "channel" : chatType === "group" ? "group" : undefined;

  const legacyResolution = resolveLegacyGroupSessionKey(ctx);
  const looksLikeGroup =
    normalizedChatType === "group" ||
    normalizedChatType === "channel" ||
    from.includes(":group:") ||
    from.includes(":channel:") ||
    legacyResolution !== null;
  if (!looksLikeGroup) {
    return null;
  }

  const providerHint = normalizeOptionalLowercaseString(ctx.Provider);

  const parts = from.split(":").filter(Boolean);
  const head = normalizeLowercaseStringOrEmpty(parts[0]);
  const headIsSurface = head ? getGroupSurfaces().has(head) : false;

  if (!headIsSurface && !providerHint && legacyResolution) {
    return legacyResolution;
  }

  const provider = headIsSurface ? head : (providerHint ?? legacyResolution?.channel);
  if (!provider) {
    return null;
  }

  const second = normalizeOptionalLowercaseString(parts[1]);
  const secondIsKind = second === "group" || second === "channel";
  const kind = secondIsKind
    ? second
    : from.includes(":channel:") || normalizedChatType === "channel"
      ? "channel"
      : "group";
  const originatingGroupTargetId =
    !secondIsKind && normalizedChatType ? resolveOriginatingGroupTargetId({ ctx, provider }) : null;
  const id = originatingGroupTargetId
    ? originatingGroupTargetId
    : headIsSurface
      ? secondIsKind
        ? parts.slice(2).join(":")
        : parts.slice(1).join(":")
      : from;
  const finalId = normalizeLowercaseStringOrEmpty(id);
  if (!finalId) {
    return null;
  }

  return {
    key: `${provider}:${kind}:${finalId}`,
    channel: provider,
    id: finalId,
    chatType: kind === "channel" ? "channel" : "group",
  };
}
