import { parseThreadSessionSuffix } from "../sessions/session-key-utils.js";
import { createTestRegistry } from "./channel-plugins.js";

function resolveGenericSessionConversation(params: { rawId: string }) {
  const parsed = parseThreadSessionSuffix(params.rawId);
  const id = parsed.baseSessionKey ?? params.rawId;
  return {
    id,
    threadId: parsed.threadId,
    baseConversationId: id,
    parentConversationCandidates:
      parsed.threadId && parsed.baseSessionKey ? [parsed.baseSessionKey] : [],
  };
}

function resolveTelegramSessionConversation(params: { kind: "group" | "channel"; rawId: string }) {
  if (params.kind !== "group") {
    return null;
  }
  const match = params.rawId.match(/^(?<chatId>.+):topic:(?<topicId>[^:]+)$/u);
  if (!match?.groups?.chatId || !match.groups.topicId) {
    return null;
  }
  const chatId = match.groups.chatId;
  return {
    id: chatId,
    threadId: match.groups.topicId,
    baseConversationId: chatId,
    parentConversationCandidates: [chatId],
  };
}

function resolveFeishuSessionConversation(params: { kind: "group" | "channel"; rawId: string }) {
  if (params.kind !== "group") {
    return null;
  }
  const senderMatch = params.rawId.match(
    /^(?<chatId>[^:]+):topic:(?<topicId>[^:]+):sender:(?<senderId>[^:]+)$/u,
  );
  if (!senderMatch?.groups?.chatId || !senderMatch.groups.topicId || !senderMatch.groups.senderId) {
    return null;
  }
  const chatId = senderMatch.groups.chatId;
  const topicId = senderMatch.groups.topicId;
  return {
    id: params.rawId,
    baseConversationId: chatId,
    parentConversationCandidates: [`${chatId}:topic:${topicId}`, chatId],
  };
}

export function createSessionConversationTestRegistry() {
  return createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        id: "discord",
        meta: {
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
          docsPath: "/channels/discord",
          blurb: "Discord test stub.",
          preferSessionLookupForAnnounceTarget: true,
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionConversation: resolveGenericSessionConversation,
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "slack",
      source: "test",
      plugin: {
        id: "slack",
        meta: {
          id: "slack",
          label: "Slack",
          selectionLabel: "Slack",
          docsPath: "/channels/slack",
          blurb: "Slack test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionConversation: resolveGenericSessionConversation,
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "matrix",
      source: "test",
      plugin: {
        id: "matrix",
        meta: {
          id: "matrix",
          label: "Matrix",
          selectionLabel: "Matrix",
          docsPath: "/channels/matrix",
          blurb: "Matrix test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionConversation: resolveGenericSessionConversation,
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "telegram",
      source: "test",
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "Telegram test stub.",
        },
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: resolveTelegramSessionConversation,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "feishu",
      source: "test",
      plugin: {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
          docsPath: "/channels/feishu",
          blurb: "Feishu test stub.",
        },
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: resolveFeishuSessionConversation,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
  ]);
}
