// Test helpers for session conversation registry keys and thread suffixes.
import { parseThreadSessionSuffix } from "../sessions/session-key-utils.js";
import { createTestRegistry } from "./channel-plugins.js";

// Mirrors generic thread suffix handling without loading real channel plugins.
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

/** Builds channel registry stubs with conversation resolvers for session tests. */
export function createSessionConversationTestRegistry() {
  return createTestRegistry([
    ...(
      [
        { id: "discord", label: "Discord", preferSessionLookupForAnnounceTarget: true },
        { id: "slack", label: "Slack" },
        { id: "matrix", label: "Matrix" },
      ] as const
    ).map(({ id, label, ...metaOverrides }) => ({
      pluginId: id,
      source: "test",
      plugin: {
        id,
        meta: {
          id,
          label,
          selectionLabel: label,
          docsPath: `/channels/${id}`,
          blurb: `${label} test stub.`,
          ...metaOverrides,
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionConversation: resolveGenericSessionConversation,
          resolveSessionTarget: ({ id: targetId }: { id: string }) => `channel:${targetId}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    })),
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
          resolveSessionTarget: ({ kind, id }: { kind: string; id: string }) =>
            kind === "group" ? id : `channel:${id}`,
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
