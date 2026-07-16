import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveQaChannelAccount } from "./accounts.js";
import {
  buildQaTarget,
  createQaBusThread,
  deleteQaBusMessage,
  editQaBusMessage,
  parseQaTarget,
  reactToQaBusMessage,
  readQaBusMessage,
  searchQaBusMessages,
  sendQaBusMessage,
} from "./bus-client.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

function listQaChannelActions(
  cfg: CoreConfig,
  accountId?: string | null,
): ChannelMessageActionName[] {
  const account = resolveQaChannelAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    return [];
  }
  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (account.config.actions?.messages !== false) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }
  if (account.config.actions?.reactions !== false) {
    actions.add("react");
    actions.add("reactions");
  }
  if (account.config.actions?.threads !== false) {
    actions.add("thread-create");
    actions.add("thread-reply");
  }
  if (account.config.actions?.search !== false) {
    actions.add("search");
  }
  return Array.from(actions);
}

function readQaSendText(params: Record<string, unknown>) {
  return (
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true })
  );
}

function readQaSendTarget(params: Record<string, unknown>) {
  const explicitTo = readStringParam(params, "to");
  if (explicitTo) {
    return explicitTo;
  }
  const channelId = readStringParam(params, "channelId");
  if (channelId) {
    return buildQaTarget({ chatType: "channel", conversationId: channelId });
  }
  const target = readStringParam(params, "target");
  if (!target) {
    return undefined;
  }
  if (/^(dm|channel):|^thread:[^/]+\/.+/i.test(target)) {
    return target;
  }
  return buildQaTarget({ chatType: "channel", conversationId: target });
}

export const qaChannelMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: (context) => ({
    actions: listQaChannelActions(context.cfg as CoreConfig, context.accountId),
    capabilities: [],
    schema: {
      properties: {
        channelId: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        messageId: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
      },
    },
  }),
  extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action === "send") {
      const to = readQaSendTarget(args);
      const threadId = readStringParam(args, "threadId");
      return to ? { to, threadId } : null;
    }
    if (action === "sendMessage") {
      return extractToolSend(args, "sendMessage") ?? null;
    }
    if (action === "threadReply") {
      const channelId = typeof args.channelId === "string" ? args.channelId.trim() : "";
      const threadId = typeof args.threadId === "string" ? args.threadId.trim() : "";
      return channelId && threadId ? { to: `thread:${channelId}/${threadId}` } : null;
    }
    return null;
  },
  handleAction: async (context) => {
    const { action, cfg, accountId, params } = context;
    const account = resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId });
    const baseUrl = account.baseUrl;

    switch (action) {
      case "send": {
        const to = readQaSendTarget(params);
        const text = readQaSendText(params);
        if (!to || text === undefined) {
          throw new Error("qa-channel send requires to/target and message/text");
        }
        const parsed = parseQaTarget(to);
        const threadId = readStringParam(params, "threadId") ?? parsed.threadId;
        const { message } = await sendQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          to: buildQaTarget({
            chatType: parsed.chatType,
            conversationId: parsed.conversationId,
            threadId,
          }),
          text,
          senderId: account.botUserId,
          senderName: account.botDisplayName,
          threadId,
          replyToId: readStringParam(params, "replyTo") ?? readStringParam(params, "replyToId"),
        });
        return jsonResult({ message });
      }
      case "thread-create": {
        const channelId =
          readStringParam(params, "channelId") ??
          (() => {
            const to = readStringParam(params, "to");
            return to ? parseQaTarget(to).conversationId : undefined;
          })();
        const title = readStringParam(params, "title") ?? "QA thread";
        if (!channelId) {
          throw new Error("qa-channel thread-create requires channelId");
        }
        const { thread } = await createQaBusThread({
          baseUrl,
          accountId: account.accountId,
          conversationId: channelId,
          title,
          createdBy: account.botUserId,
        });
        return jsonResult({
          thread,
          target: `thread:${channelId}/${thread.id}`,
        });
      }
      case "thread-reply": {
        const channelId = readStringParam(params, "channelId");
        const threadId = readStringParam(params, "threadId");
        const text = readStringParam(params, "text");
        if (!channelId || !threadId || !text) {
          throw new Error("qa-channel thread-reply requires channelId, threadId, and text");
        }
        const { message } = await sendQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          to: `thread:${channelId}/${threadId}`,
          text,
          senderId: account.botUserId,
          senderName: account.botDisplayName,
          threadId,
        });
        return jsonResult({ message });
      }
      case "react": {
        const messageId = readStringParam(params, "messageId");
        const emoji = readStringParam(params, "emoji");
        if (!messageId || !emoji) {
          throw new Error("qa-channel react requires messageId and emoji");
        }
        const { message } = await reactToQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          messageId,
          emoji,
          senderId: account.botUserId,
        });
        return jsonResult({ message });
      }
      case "reactions":
      case "read": {
        const messageId = readStringParam(params, "messageId");
        if (!messageId) {
          throw new Error(`qa-channel ${action} requires messageId`);
        }
        const { message } = await readQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          messageId,
        });
        return jsonResult({ message });
      }
      case "edit": {
        const messageId = readStringParam(params, "messageId");
        const text = readStringParam(params, "text");
        if (!messageId || !text) {
          throw new Error("qa-channel edit requires messageId and text");
        }
        const { message } = await editQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          messageId,
          text,
        });
        return jsonResult({ message });
      }
      case "delete": {
        const messageId = readStringParam(params, "messageId");
        if (!messageId) {
          throw new Error("qa-channel delete requires messageId");
        }
        const { message } = await deleteQaBusMessage({
          baseUrl,
          accountId: account.accountId,
          messageId,
        });
        return jsonResult({ message });
      }
      case "search": {
        const query = readStringParam(params, "query");
        const channelId = readStringParam(params, "channelId");
        const threadId = readStringParam(params, "threadId");
        const { messages } = await searchQaBusMessages({
          baseUrl,
          input: {
            accountId: account.accountId,
            query,
            conversationId: channelId,
            threadId,
          },
        });
        return jsonResult({ messages });
      }
      default:
        throw new Error(`qa-channel action not implemented: ${action}`);
    }
  },
};
