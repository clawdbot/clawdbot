import type { MsgContext } from "../../auto-reply/templating.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../../config/sessions.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { parseIMessageTarget, normalizeIMessageHandle } from "../../imessage/targets.js";
import {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { createSlackWebClient } from "../../slack/client.js";
import { normalizeAllowListLower } from "../../slack/monitor/allow-list.js";
import {
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../../signal/identity.js";
import { parseSlackTarget } from "../../slack/targets.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import { resolveTelegramTargetChatType } from "../../telegram/inline-buttons.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: MoltbotConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;
// Cache Slack channel type lookups to avoid repeated API calls.
const SLACK_CHANNEL_TYPE_CACHE = new Map<string, "channel" | "group" | "dm" | "unknown">();

function looksLikeUuid(value: string): boolean {
  if (UUID_RE.test(value) || UUID_COMPACT_RE.test(value)) return true;
  const compact = value.replace(/-/g, "");
  if (!/^[0-9a-f]+$/i.test(compact)) return false;
  return /[a-f]/i.test(compact);
}

function normalizeThreadId(value?: string | number | null): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${channel.toLowerCase()}:`;
  if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

function inferPeerKind(params: {
  channel: ChannelId;
  resolvedTarget?: ResolvedMessagingTarget;
}): RoutePeerKind {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") return "dm";
  if (resolvedKind === "channel") return "channel";
  if (resolvedKind === "group") {
    const plugin = getChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) return "channel";
    return "group";
  }
  return "dm";
}

function buildBaseSessionKey(params: {
  cfg: MoltbotConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
  });
}

// Best-effort mpim detection: allowlist/config, then Slack API (if token available).
async function resolveSlackChannelType(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown"> {
  const channelId = params.channelId.trim();
  if (!channelId) return "unknown";
  const cached = SLACK_CHANNEL_TYPE_CACHE.get(`${params.accountId ?? "default"}:${channelId}`);
  if (cached) return cached;

  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const groupChannels = normalizeAllowListLower(account.dm?.groupChannels);
  const channelIdLower = channelId.toLowerCase();
  if (
    groupChannels.includes(channelIdLower) ||
    groupChannels.includes(`slack:${channelIdLower}`) ||
    groupChannels.includes(`channel:${channelIdLower}`) ||
    groupChannels.includes(`group:${channelIdLower}`) ||
    groupChannels.includes(`mpim:${channelIdLower}`)
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "group");
    return "group";
  }

  const channelKeys = Object.keys(account.channels ?? {});
  if (
    channelKeys.some((key) => {
      const normalized = key.trim().toLowerCase();
      return (
        normalized === channelIdLower ||
        normalized === `channel:${channelIdLower}` ||
        normalized.replace(/^#/, "") === channelIdLower
      );
    })
  ) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "channel");
    return "channel";
  }

  const token =
    account.botToken?.trim() ||
    (typeof account.config.userToken === "string" ? account.config.userToken.trim() : "");
  if (!token) {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "unknown");
    return "unknown";
  }

  try {
    const client = createSlackWebClient(token);
    const info = await client.conversations.info({ channel: channelId });
    const channel = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
    const type = channel?.is_im ? "dm" : channel?.is_mpim ? "group" : "channel";
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, type);
    return type;
  } catch {
    SLACK_CHANNEL_TYPE_CACHE.set(`${account.accountId}:${channelId}`, "unknown");
    return "unknown";
  }
}

async function resolveSlackSession(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const parsed = parseSlackTarget(params.target, { defaultKind: "channel" });
  if (!parsed) return null;
  const isDm = parsed.kind === "user";
  let peerKind: RoutePeerKind = isDm ? "dm" : "channel";
  if (!isDm && /^G/i.test(parsed.id)) {
    // Slack mpim/group DMs share the G-prefix; detect to align session keys with inbound.
    const channelType = await resolveSlackChannelType({
      cfg: params.cfg,
      accountId: params.accountId,
      channelId: parsed.id,
    });
    if (channelType === "group") peerKind = "group";
    if (channelType === "dm") peerKind = "dm";
  }
  const peer: RoutePeer = {
    kind: peerKind,
    id: parsed.id,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "slack",
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeThreadId(params.threadId ?? params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: peerKind === "dm" ? "direct" : "channel",
    from:
      peerKind === "dm"
        ? `slack:${parsed.id}`
        : peerKind === "group"
          ? `slack:group:${parsed.id}`
          : `slack:channel:${parsed.id}`,
    to: peerKind === "dm" ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId,
  };
}

function resolveDiscordSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseDiscordTarget(params.target, { defaultKind: "channel" });
  if (!parsed) return null;
  const isDm = parsed.kind === "user";
  const peer: RoutePeer = {
    kind: isDm ? "dm" : "channel",
    id: parsed.id,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer,
  });
  const explicitThreadId = normalizeThreadId(params.threadId);
  const threadCandidate = explicitThreadId ?? normalizeThreadId(params.replyToId);
  // Discord threads use their own channel id; avoid adding a :thread suffix.
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadCandidate,
    useSuffix: false,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isDm ? "direct" : "channel",
    from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
    to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
    threadId: explicitThreadId ?? undefined,
  };
}

function resolveTelegramSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) return null;
  const parsedThreadId = parsed.messageThreadId;
  const fallbackThreadId = normalizeThreadId(params.threadId);
  const resolvedThreadId =
    parsedThreadId ?? (fallbackThreadId ? Number.parseInt(fallbackThreadId, 10) : undefined);
  // Telegram topics are encoded in the peer id (chatId:topic:<id>).
  const chatType = resolveTelegramTargetChatType(params.target);
  // If the target is a username and we lack a resolvedTarget, default to DM to avoid group keys.
  const isGroup =
    chatType === "group" ||
    (chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "dm",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `telegram:group:${peerId}` : `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    threadId: resolvedThreadId,
  };
}

function resolveWhatsAppSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) return null;
  const isGroup = isWhatsAppGroupJid(normalized);
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "dm",
    id: normalized,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: normalized,
    to: normalized,
  };
}

function resolveSignalSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "signal");
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith("group:")) {
    const groupId = stripped.slice("group:".length).trim();
    if (!groupId) return null;
    const peer: RoutePeer = { kind: "group", id: groupId };
    const baseSessionKey = buildBaseSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "signal",
      accountId: params.accountId,
      peer,
    });
    return {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  let recipient = stripped.trim();
  if (lowered.startsWith("username:")) {
    recipient = stripped.slice("username:".length).trim();
  } else if (lowered.startsWith("u:")) {
    recipient = stripped.slice("u:".length).trim();
  }
  if (!recipient) return null;

  const uuidCandidate = recipient.toLowerCase().startsWith("uuid:")
    ? recipient.slice("uuid:".length)
    : recipient;
  const sender = resolveSignalSender({
    sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
    sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient,
  });
  const peerId = sender ? resolveSignalPeerId(sender) : recipient;
  const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
  const peer: RoutePeer = { kind: "dm", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "signal",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "direct",
    from: `signal:${displayRecipient}`,
    to: `signal:${displayRecipient}`,
  };
}

function resolveIMessageSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseIMessageTarget(params.target);
  if (parsed.kind === "handle") {
    const handle = normalizeIMessageHandle(parsed.to);
    if (!handle) return null;
    const peer: RoutePeer = { kind: "dm", id: handle };
    const baseSessionKey = buildBaseSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "imessage",
      accountId: params.accountId,
      peer,
    });
    return {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: "direct",
      from: `imessage:${handle}`,
      to: `imessage:${handle}`,
    };
  }

  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : parsed.kind === "chat_guid"
        ? parsed.chatGuid
        : parsed.chatIdentifier;
  if (!peerId) return null;
  const peer: RoutePeer = { kind: "group", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "imessage",
    accountId: params.accountId,
    peer,
  });
  const toPrefix =
    parsed.kind === "chat_id"
      ? "chat_id"
      : parsed.kind === "chat_guid"
        ? "chat_guid"
        : "chat_identifier";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "group",
    from: `imessage:group:${peerId}`,
    to: `${toPrefix}:${peerId}`,
  };
}

function resolveMatrixSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "matrix");
  const isUser =
    params.resolvedTarget?.kind === "user" || stripped.startsWith("@") || /^user:/i.test(stripped);
  const rawId = stripKindPrefix(stripped);
  if (!rawId) return null;
  const peer: RoutePeer = { kind: isUser ? "dm" : "channel", id: rawId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `matrix:${rawId}` : `matrix:channel:${rawId}`,
    to: `room:${rawId}`,
  };
}

function resolveMSTeamsSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^(msteams|teams):/i, "").trim();

  const lower = trimmed.toLowerCase();
  const isUser = lower.startsWith("user:");
  const rawId = stripKindPrefix(trimmed);
  if (!rawId) return null;
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const peer: RoutePeer = {
    kind: isUser ? "dm" : isChannel ? "channel" : "group",
    id: conversationId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : isChannel ? "channel" : "group",
    from: isUser
      ? `msteams:${conversationId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`,
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  };
}

function resolveMattermostSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^mattermost:/i, "").trim();
  const lower = trimmed.toLowerCase();
  const isUser = lower.startsWith("user:") || trimmed.startsWith("@");
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripKindPrefix(trimmed);
  if (!rawId) return null;
  const peer: RoutePeer = { kind: isUser ? "dm" : "channel", id: rawId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer,
  });
  const threadId = normalizeThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer,
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
    threadId,
  };
}

function resolveBlueBubblesSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const stripped = stripProviderPrefix(params.target, "bluebubbles");
  const lower = stripped.toLowerCase();
  const isGroup =
    lower.startsWith("chat_id:") ||
    lower.startsWith("chat_guid:") ||
    lower.startsWith("chat_identifier:") ||
    lower.startsWith("group:");
  const rawPeerId = isGroup
    ? stripKindPrefix(stripped)
    : stripped.replace(/^(imessage|sms|auto):/i, "");
  // BlueBubbles inbound group ids omit chat_* prefixes; strip them to align sessions.
  const peerId = isGroup
    ? rawPeerId.replace(/^(chat_id|chat_guid|chat_identifier):/i, "")
    : rawPeerId;
  if (!peerId) return null;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "dm",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
    to: `bluebubbles:${stripped}`,
  };
}

function resolveNextcloudTalkSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = params.target.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^(nextcloud-talk|nc-talk|nc):/i, "").trim();
  trimmed = trimmed.replace(/^room:/i, "").trim();
  if (!trimmed) return null;
  const peer: RoutePeer = { kind: "group", id: trimmed };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "group",
    from: `nextcloud-talk:room:${trimmed}`,
    to: `nextcloud-talk:${trimmed}`,
  };
}

function resolveZaloSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, "zalo")
    .replace(/^(zl):/i, "")
    .trim();
  if (!trimmed) return null;
  const isGroup = trimmed.toLowerCase().startsWith("group:");
  const peerId = stripKindPrefix(trimmed);
  const peer: RoutePeer = { kind: isGroup ? "group" : "dm", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalo",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalo:group:${peerId}` : `zalo:${peerId}`,
    to: `zalo:${peerId}`,
  };
}

function resolveZalouserSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, "zalouser")
    .replace(/^(zlu):/i, "")
    .trim();
  if (!trimmed) return null;
  const isGroup = trimmed.toLowerCase().startsWith("group:");
  const peerId = stripKindPrefix(trimmed);
  // Keep DM vs group aligned with inbound sessions for Zalo Personal.
  const peer: RoutePeer = { kind: isGroup ? "group" : "dm", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalouser",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
    to: `zalouser:${peerId}`,
  };
}

function resolveNostrSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, "nostr").trim();
  if (!trimmed) return null;
  const peer: RoutePeer = { kind: "dm", id: trimmed };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: "direct",
    from: `nostr:${trimmed}`,
    to: `nostr:${trimmed}`,
  };
}

function normalizeTlonShip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}

function resolveTlonSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = stripProviderPrefix(params.target, "tlon");
  trimmed = trimmed.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  let isGroup =
    lower.startsWith("group:") || lower.startsWith("room:") || lower.startsWith("chat/");
  let peerId = trimmed;
  if (lower.startsWith("group:") || lower.startsWith("room:")) {
    peerId = trimmed.replace(/^(group|room):/i, "").trim();
    if (!peerId.startsWith("chat/")) {
      const parts = peerId.split("/").filter(Boolean);
      if (parts.length === 2) {
        peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      }
    }
    isGroup = true;
  } else if (lower.startsWith("dm:")) {
    peerId = normalizeTlonShip(trimmed.slice("dm:".length));
    isGroup = false;
  } else if (lower.startsWith("chat/")) {
    peerId = trimmed;
    isGroup = true;
  } else if (trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length === 2) {
      peerId = `chat/${normalizeTlonShip(parts[0])}/${parts[1]}`;
      isGroup = true;
    }
  } else {
    peerId = normalizeTlonShip(trimmed);
  }

  const peer: RoutePeer = { kind: isGroup ? "group" : "dm", id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "tlon",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `tlon:group:${peerId}` : `tlon:${peerId}`,
    to: `tlon:${peerId}`,
  };
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) return null;
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) return null;
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "dm" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "dm" ? `${params.channel}:${peerId}` : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "dm" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) return null;
  switch (params.channel) {
    case "slack":
      return await resolveSlackSession({ ...params, target });
    case "discord":
      return resolveDiscordSession({ ...params, target });
    case "telegram":
      return resolveTelegramSession({ ...params, target });
    case "whatsapp":
      return resolveWhatsAppSession({ ...params, target });
    case "signal":
      return resolveSignalSession({ ...params, target });
    case "imessage":
      return resolveIMessageSession({ ...params, target });
    case "matrix":
      return resolveMatrixSession({ ...params, target });
    case "msteams":
      return resolveMSTeamsSession({ ...params, target });
    case "mattermost":
      return resolveMattermostSession({ ...params, target });
    case "bluebubbles":
      return resolveBlueBubblesSession({ ...params, target });
    case "nextcloud-talk":
      return resolveNextcloudTalkSession({ ...params, target });
    case "zalo":
      return resolveZaloSession({ ...params, target });
    case "zalouser":
      return resolveZalouserSession({ ...params, target });
    case "nostr":
      return resolveNostrSession({ ...params, target });
    case "tlon":
      return resolveTlonSession({ ...params, target });
    default:
      return resolveFallbackSession({ ...params, target });
  }
}

export async function ensureOutboundSessionEntry(params: {
  cfg: MoltbotConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
