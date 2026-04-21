import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "../../plugin-sdk/core.js";
import {
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
  type RoutePeer,
} from "../../plugin-sdk/routing.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function createSessionRouteTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveOutboundSessionRoute: (
    params: ChannelOutboundSessionRouteParams,
  ) => Awaited<
    ReturnType<NonNullable<NonNullable<ChannelPlugin["messaging"]>["resolveOutboundSessionRoute"]>>
  >;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.label,
      capabilities: { chatTypes: ["direct", "group", "channel"] },
    }),
    messaging: {
      resolveOutboundSessionRoute: params.resolveOutboundSessionRoute,
    },
  };
}

function buildThreadedChannelRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
  useSuffix?: boolean;
}) {
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const normalizedThreadId = normalizeOutboundThreadId(params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: normalizedThreadId,
    useSuffix: params.useSuffix,
  });
  return {
    sessionKey: threadKeys.sessionKey,
    baseSessionKey,
    peer: params.peer,
    chatType: params.chatType,
    from: params.from,
    to: params.to,
    ...(normalizedThreadId !== undefined ? { threadId: params.threadId } : {}),
  };
}

function parseForumTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^forum:/i, "")
    .replace(/^group:/i, "");
  const prefixedTopic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    const chatId = prefixedTopic[1];
    return {
      chatId,
      messageThreadId: Number.parseInt(prefixedTopic[2], 10),
      chatType: chatId.startsWith("-") ? "group" : "direct",
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : trimmed.startsWith("@") ? "unknown" : "direct",
  };
}

function parseForumThreadIdForTest(threadId?: string | number | null): number | undefined {
  const normalized = normalizeOutboundThreadId(threadId);
  if (!normalized) {
    return undefined;
  }
  const topicMatch = /(?:^|:topic:|:)(\d+)$/i.exec(normalized);
  if (!topicMatch) {
    return undefined;
  }
  return Number.parseInt(topicMatch[1], 10);
}

function buildForumGroupPeerIdForTest(chatId: string, messageThreadId?: number): string {
  return messageThreadId ? `${chatId}:topic:${messageThreadId}` : chatId;
}

function resolveForumOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseForumTargetForTest(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const resolvedThreadId = parsed.messageThreadId ?? parseForumThreadIdForTest(params.threadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind !== undefined &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? buildForumGroupPeerIdForTest(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  if (isGroup) {
    return buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "forum",
      accountId: params.accountId,
      peer,
      chatType: "group",
      from: `forum:group:${peerId}`,
      to: `forum:${chatId}`,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  }
  return buildThreadedChannelRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "forum",
    accountId: params.accountId,
    peer,
    chatType: "direct",
    from:
      resolvedThreadId !== undefined
        ? `forum:${chatId}:topic:${resolvedThreadId}`
        : `forum:${chatId}`,
    to: `forum:${chatId}`,
    threadId: resolvedThreadId,
  });
}

function resolveWorkspaceOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "workspace"));
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isDm = lower.startsWith("user:") || lower.startsWith("workspace:") || /^u/i.test(rawId);
  const workspaceConfig = params.cfg.channels?.workspace as
    | { dm?: { groupChannels?: unknown[] } }
    | undefined;
  const isGroupChannel =
    /^g/i.test(rawId) &&
    Array.isArray(workspaceConfig?.dm?.groupChannels) &&
    workspaceConfig.dm.groupChannels.some(
      (candidate: unknown) => normalizeLowercaseStringOrEmpty(String(candidate)) === normalizedId,
    );
  const peerKind: RoutePeer["kind"] = isDm ? "direct" : isGroupChannel ? "group" : "channel";
  return buildThreadedChannelRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "workspace",
    accountId: params.accountId,
    peer: { kind: peerKind, id: normalizedId },
    chatType: peerKind === "direct" ? "direct" : peerKind === "group" ? "group" : "channel",
    from: isDm
      ? `workspace:${rawId}`
      : isGroupChannel
        ? `workspace:group:${rawId}`
        : `workspace:channel:${rawId}`,
    to: isDm ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.replyToId ?? params.threadId ?? undefined,
  });
}

function resolveGuildChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const resolvedKind = params.resolvedTarget?.kind;
  let kind: "user" | "channel";
  if (resolvedKind === "user") {
    kind = "user";
  } else if (resolvedKind === "channel" || resolvedKind === "group") {
    kind = "channel";
  } else if (/^user:/i.test(trimmed) || /^guildchat:/i.test(trimmed) || /^<@!?/.test(trimmed)) {
    kind = "user";
  } else if (/^channel:/i.test(trimmed)) {
    kind = "channel";
  } else if (/^\d+$/u.test(trimmed)) {
    throw new Error("Ambiguous Guild Chat recipient");
  } else {
    kind = "channel";
  }
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "guildchat"));
  if (!rawId) {
    return null;
  }
  const peer: RoutePeer = {
    kind: kind === "user" ? "direct" : "channel",
    id: rawId,
  };
  return buildThreadedChannelRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "guildchat",
    accountId: params.accountId,
    peer,
    chatType: kind === "user" ? "direct" : "channel",
    from: kind === "user" ? `guildchat:${rawId}` : `guildchat:channel:${rawId}`,
    to: kind === "user" ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.threadId ?? undefined,
    useSuffix: false,
  });
}

function resolveBoardChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const isUser = params.resolvedTarget?.kind === "user" || /^user:/i.test(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "boardchat"));
  if (!rawId) {
    return null;
  }
  return buildThreadedChannelRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "boardchat",
    accountId: params.accountId,
    peer: { kind: isUser ? "direct" : "channel", id: rawId },
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `boardchat:${rawId}` : `boardchat:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.replyToId ?? params.threadId ?? undefined,
  });
}

function resolveMobileChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeOptionalLowercaseString(
    stripChannelTargetPrefix(params.target, "mobilechat"),
  );
  if (!normalized) {
    return null;
  }
  const isGroup = normalized.endsWith("@g.us");
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mobilechat",
    accountId: params.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: normalized },
    chatType: isGroup ? "group" : "direct",
    from: normalized,
    to: normalized,
  });
}

function resolveMatrixOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "matrix");
  const isUser =
    params.resolvedTarget?.kind === "user" || stripped.startsWith("@") || /^user:/i.test(stripped);
  const rawId = stripTargetKindPrefix(stripped);
  if (!rawId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer: { kind: isUser ? "direct" : "channel", id: rawId },
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `matrix:${rawId}` : `matrix:channel:${rawId}`,
    to: `room:${rawId}`,
  });
}

function resolveMeetingChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "meetingchat", "meet");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isUser = lower.startsWith("user:");
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const peerKind: RoutePeer["kind"] = isUser ? "direct" : isChannel ? "channel" : "group";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "meetingchat",
    accountId: params.accountId,
    peer: { kind: peerKind, id: conversationId },
    chatType: peerKind,
    from: isUser
      ? `meetingchat:${conversationId}`
      : isChannel
        ? `meetingchat:channel:${conversationId}`
        : `meetingchat:group:${conversationId}`,
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
}

function resolveCollabChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "collabchat", "collab");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  let isGroup = false;
  if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
    trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
    isGroup = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
  } else if (
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("ou_") &&
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("on_")
  ) {
    isGroup = false;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "collabchat",
    accountId: params.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: trimmed },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `collabchat:group:${trimmed}` : `collabchat:${trimmed}`,
    to: trimmed,
  });
}

function resolveNextcloudTalkOutboundSessionRouteForTest(
  params: ChannelOutboundSessionRouteParams,
) {
  const roomId = stripTargetKindPrefix(
    stripChannelTargetPrefix(params.target, "nextcloud-talk", "nc-talk", "nc"),
  );
  if (!roomId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer: { kind: "group", id: roomId },
    chatType: "group",
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  });
}

function resolveLocalChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "localchat");
  if (!stripped) {
    return null;
  }
  const match = /^(chat_guid|chat_identifier|chat_id):(.+)$/i.exec(stripped);
  const rawId = match ? match[2].trim() : stripped.trim();
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isGroup = match !== null;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "localchat",
    accountId: params.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: normalizedId },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${rawId}` : `localchat:${rawId}`,
    to: `localchat:${stripped}`,
  });
}

function resolveZaloOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalo", "zl");
  if (!trimmed) {
    return null;
  }
  const isGroup = normalizeLowercaseStringOrEmpty(trimmed).startsWith("group:");
  const peerId = stripTargetKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalo",
    accountId: params.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalo:group:${peerId}` : `zalo:${peerId}`,
    to: `zalo:${peerId}`,
  });
}

function resolveZalouserOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalouser", "zlu");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isGroup = lower.startsWith("group:") || lower.startsWith("g:");
  const peerId = trimmed.replace(/^(group|user|g|u|dm):/i, "").trim();
  if (!peerId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zalouser",
    accountId: params.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
    to: `zalouser:${peerId}`,
  });
}

function resolveNostrOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const target = stripChannelTargetPrefix(params.target, "nostr");
  if (!target) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    peer: { kind: "direct", id: target },
    chatType: "direct",
    from: `nostr:${target}`,
    to: `nostr:${target}`,
  });
}

function resolveTlonOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "tlon").trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:")) {
    const nest = `chat/${trimmed.slice("group:".length).trim()}`;
    return buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "tlon",
      accountId: params.accountId,
      peer: { kind: "group", id: nest },
      chatType: "group",
      from: `tlon:group:${nest}`,
      to: `tlon:${nest}`,
    });
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "tlon",
    accountId: params.accountId,
    peer: { kind: "direct", id: trimmed },
    chatType: "direct",
    from: `tlon:${trimmed}`,
    to: `tlon:${trimmed}`,
  });
}

export function setMinimalOutboundSessionPluginRegistryForTests(): void {
  const plugins: ChannelPlugin[] = [
    createSessionRouteTestPlugin({
      id: "mobilechat",
      label: "Mobile Chat",
      resolveOutboundSessionRoute: resolveMobileChatOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "matrix",
      label: "Matrix",
      resolveOutboundSessionRoute: resolveMatrixOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "meetingchat",
      label: "Meeting Chat",
      resolveOutboundSessionRoute: resolveMeetingChatOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "workspace",
      label: "Workspace",
      resolveOutboundSessionRoute: resolveWorkspaceOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "forum",
      label: "Forum",
      resolveOutboundSessionRoute: resolveForumOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "guildchat",
      label: "Guild Chat",
      resolveOutboundSessionRoute: resolveGuildChatOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "nextcloud-talk",
      label: "Nextcloud Talk",
      resolveOutboundSessionRoute: resolveNextcloudTalkOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "localchat",
      label: "Local Chat",
      resolveOutboundSessionRoute: resolveLocalChatOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "zalo",
      label: "Zalo",
      resolveOutboundSessionRoute: resolveZaloOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "zalouser",
      label: "Zalo Personal",
      resolveOutboundSessionRoute: resolveZalouserOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "nostr",
      label: "Nostr",
      resolveOutboundSessionRoute: resolveNostrOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "tlon",
      label: "Tlon",
      resolveOutboundSessionRoute: resolveTlonOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "collabchat",
      label: "Collab Chat",
      resolveOutboundSessionRoute: resolveCollabChatOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "boardchat",
      label: "Board Chat",
      resolveOutboundSessionRoute: resolveBoardChatOutboundSessionRouteForTest,
    }),
  ];
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({
        pluginId: plugin.id,
        plugin,
        source: "test",
      })),
    ),
  );
}
