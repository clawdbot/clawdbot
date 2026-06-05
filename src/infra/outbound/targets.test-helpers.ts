// Shared outbound target test fixtures provide deterministic channel plugins,
// target parsing, and session-route behavior.
import type {
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

// Target fixtures keep normalization deterministic while exercising plugin-owned seams.
function readTestDefaultTo(cfg: OpenClawConfig, channelId: string): string | undefined {
  const channels = cfg.channels as Record<string, { defaultTo?: unknown }> | undefined;
  const value = channels?.[channelId]?.defaultTo;
  return typeof value === "string" ? value : undefined;
}

function stripTestPrefix(raw: string, channelId: string): string {
  return raw.replace(new RegExp(`^${channelId}:`, "i"), "").trim();
}

/** Parses forum test targets with optional topic/thread suffixes. */
export function parseForumTargetForTest(raw: string): {
  roomId: string;
  threadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = stripTestPrefix(raw.trim(), "forum");
  const topicMatch = /^(.*):topic:(\d+)$/i.exec(trimmed);
  const roomId = topicMatch?.[1]?.trim() || trimmed;
  const threadId = topicMatch?.[2] ? Number.parseInt(topicMatch[2], 10) : undefined;
  const chatType = roomId.startsWith("dm:")
    ? "direct"
    : roomId.startsWith("room:")
      ? "group"
      : "unknown";
  return { roomId, threadId, chatType };
}

function normalizeGenericTargetForTest(raw: string, channelId: string): string | null {
  const normalized = stripTestPrefix(raw, channelId).toLowerCase().replace(/\s+/gu, "-");
  if (!normalized || normalized === "invalid") {
    return null;
  }
  return normalized;
}

function createGenericResolveTarget(
  channelId: string,
  label: string,
): ChannelOutboundAdapter["resolveTarget"] {
  return ({ to }) => {
    const normalized = to ? normalizeGenericTargetForTest(to, channelId) : null;
    if (!normalized) {
      return { ok: false, error: new Error(`${label} target is required`) };
    }
    return { ok: true, to: normalized };
  };
}

export function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.replace(/^telegram:/i, "").trim();
  const topicMatch = withoutPrefix.match(/^(.*):topic:(\d+)$/i);
  const colonMatch = withoutPrefix.match(/^(-?\d+):(\d+)$/i);
  const chatId = topicMatch?.[1]?.trim() || colonMatch?.[1] || withoutPrefix;
  const messageThreadId = topicMatch?.[2]
    ? Number.parseInt(topicMatch[2], 10)
    : colonMatch?.[2]
      ? Number.parseInt(colonMatch[2], 10)
      : undefined;
  const numericId = chatId.startsWith("-") ? chatId.slice(1) : chatId;
  const chatType =
    /^\d+$/.test(numericId) && !chatId.startsWith("-100")
      ? "direct"
      : chatId.startsWith("-")
        ? "group"
        : "unknown";
  return { chatId, messageThreadId, chatType };
}

export const telegramMessagingForTest: ChannelMessagingAdapter = {
  targetPrefixes: ["telegram", "tg"],
  inferTargetChatType: ({ to }) => {
    const target = parseTelegramTargetForTest(to);
    return target.chatType === "unknown" ? undefined : target.chatType;
  },
  resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, resolvedTarget, threadId }) => {
    const parsed = parseTelegramTargetForTest(target);
    const resolvedThreadId = parsed.messageThreadId ?? threadId ?? undefined;
    const isGroup =
      parsed.chatType === "group" ||
      (parsed.chatType === "unknown" &&
        resolvedTarget?.kind !== undefined &&
        resolvedTarget.kind !== "user");
    const peerId =
      isGroup && resolvedThreadId ? `${parsed.chatId}:topic:${resolvedThreadId}` : parsed.chatId;
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "telegram",
      accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      chatType: isGroup ? "group" : "direct",
      from: isGroup ? `telegram:group:${peerId}` : `telegram:${parsed.chatId}`,
      to: parsed.chatId,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  },
};

export const forumMessagingForTest: ChannelMessagingAdapter = {
  targetPrefixes: ["forum"],
  inferTargetChatType: ({ to }) => {
    const target = parseForumTargetForTest(to);
    return target.chatType === "unknown" ? undefined : target.chatType;
  },
  targetResolver: {
    hint: "<room|dm target>",
  },
  resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, threadId }) => {
    const parsed = parseForumTargetForTest(target);
    const resolvedThreadId = parsed.threadId ?? threadId ?? undefined;
    const chatType = parsed.chatType === "direct" ? "direct" : "group";
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "forum",
      accountId,
      peer: {
        kind: chatType,
        id: parsed.roomId,
      },
      chatType,
      from: chatType === "direct" ? `forum:${parsed.roomId}` : `forum:group:${parsed.roomId}`,
      to: parsed.roomId,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  },
  preserveHeartbeatThreadIdForGroupRoute: true,
};

export function createTestChannelPlugin(params: {
  id: ChannelPlugin["id"];
  label?: string;
  outbound?: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  resolveDefaultTo?: (params: { cfg: OpenClawConfig }) => string | undefined;
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label ?? String(params.id),
      selectionLabel: params.label ?? String(params.id),
      docsPath: `/channels/${params.id}`,
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
      ...(params.resolveDefaultTo
        ? {
            resolveDefaultTo: params.resolveDefaultTo,
          }
        : {}),
    },
    ...(params.outbound ? { outbound: params.outbound } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
  };
}

export function createGenericTargetTestPlugin(
  id: ChannelPlugin["id"],
  label = String(id),
): ChannelPlugin {
  return createTestChannelPlugin({
    id,
    label,
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: id, messageId: `${id}-msg` }),
      resolveTarget: createGenericResolveTarget(String(id), label),
    },
    messaging: {
      targetPrefixes: [String(id)],
    },
    resolveDefaultTo: ({ cfg }) => readTestDefaultTo(cfg, String(id)),
  });
}

export function createForumTargetTestPlugin(): ChannelPlugin {
  return createTestChannelPlugin({
    id: "forum",
    label: "Forum",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "forum", messageId: "forum-msg" }),
      resolveTarget: createGenericResolveTarget("forum", "Forum"),
    },
    messaging: forumMessagingForTest,
    resolveDefaultTo: ({ cfg }) => readTestDefaultTo(cfg, "forum"),
  });
}

export function createTargetsTestRegistry(
  plugins: ChannelPlugin[] = [
    createGenericTargetTestPlugin("alpha", "Alpha"),
    createGenericTargetTestPlugin("beta", "Beta"),
    createForumTargetTestPlugin(),
  ],
) {
  return createTestRegistry(
    plugins.map((plugin) => ({
      pluginId: plugin.id,
      plugin,
      source: "test",
    })),
  );
}
