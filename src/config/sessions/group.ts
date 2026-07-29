// Group session keys convert channel-specific group metadata into stable store ids.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeHyphenSlug } from "@openclaw/normalization-core/string-normalization";
import type { MsgContext } from "../../auto-reply/templating.js";
import { listChannelPlugins } from "../../channels/plugins/registry.js";
import { normalizeSessionPeerId } from "../../sessions/session-key-utils.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

type LegacyGroupSessionSurface = {
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => GroupKeyResolution | null;
};

function resolveLegacyGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  // Legacy plugin resolvers stay first-class because some channels still expose native group ids
  // only through channel-owned context parsing.
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

function joinOpaqueTail(parts: string[], start: number): string | null {
  return normalizeOptionalString(parts[start]) ? parts.slice(start).join(":") : null;
}

function resolveOriginatingGroupTargetId(params: {
  ctx: MsgContext;
  provider: string;
}): string | null {
  const target = normalizeOptionalString(params.ctx.OriginatingTo ?? params.ctx.To) ?? "";
  if (!target) {
    return null;
  }
  const parts = target.split(":");
  if (parts.length < 2) {
    return null;
  }

  // Some channels send the sender in `From` and the actual group/channel route in `To`.
  // Prefer that route when it carries a recognized provider/kind prefix.
  const head = normalizeLowercaseStringOrEmpty(parts[0]);
  const second = normalizeOptionalLowercaseString(parts[1]);
  const secondIsKind = second === "group" || second === "channel";
  if (secondIsKind && (head === params.provider || getGroupSurfaces().has(head))) {
    return joinOpaqueTail(parts, 2);
  }
  if (head === params.provider || head === "chat" || head === "room" || head === "group") {
    return joinOpaqueTail(parts, 1);
  }
  if (head === "channel") {
    return joinOpaqueTail(parts, 1);
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

/**
 * Builds a human-readable group/channel title from stored chat metadata.
 * Prefers the native channel name (#general) or the chat subject verbatim;
 * returns undefined when only opaque route ids are available so callers can
 * fall back to the compact token form below.
 */
export function buildGroupDisplayTitle(params: {
  subject?: string;
  groupChannel?: string;
  space?: string;
}): string | undefined {
  const subject = normalizeOptionalString(params.subject);
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const space = normalizeOptionalString(params.space);
  if (groupChannel) {
    const channelLabel = groupChannel.startsWith("#") ? groupChannel : `#${groupChannel}`;
    return space ? `${space} ${channelLabel}` : channelLabel;
  }
  return subject ?? space ?? undefined;
}

/** Builds a compact display label for group sessions from channel metadata or ids. */
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
  // Very long opaque ids become a readable stable token instead of leaking full route ids into UI.
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

/**
 * Resolves channel/group chat context into the persisted group session key.
 *
 * Provider-prefixed ids use channel-owned normalization, while legacy plugin resolvers remain a
 * fallback for older channel surfaces that cannot yet express the generic route shape.
 */
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

  const parts = from.split(":");
  const head = normalizeLowercaseStringOrEmpty(parts[0]);
  const headIsSurface = head ? getGroupSurfaces().has(head) : false;

  if (!headIsSurface && !providerHint && legacyResolution) {
    // Without a provider hint, trust the plugin-owned legacy resolver; guessing from `From`
    // would merge unrelated channel/group keys.
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
  // Originating targets preserve provider-native group ids, including case-sensitive Signal ids
  // that would be corrupted by normalizing the sender-shaped `From` fallback.
  const id = originatingGroupTargetId
    ? originatingGroupTargetId
    : headIsSurface
      ? secondIsKind
        ? joinOpaqueTail(parts, 2)
        : joinOpaqueTail(parts, 1)
      : from;
  if (!id) {
    return null;
  }
  const finalId = normalizeSessionPeerId({ channel: provider, peerKind: kind, peerId: id });
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
