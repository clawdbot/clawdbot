// Qa Channel plugin module implements channel behavior.
import type { ChannelThreadingToolContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendPayloadContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  buildQaTarget,
  normalizeQaTarget,
  parseQaTarget,
  resolveQaTargetThread,
} from "./bus-client.js";
import { qaChannelMessageActions } from "./channel-actions.js";
import { createQaChannelPluginBase, QA_CHANNEL_ID, qaChannelRuntimeMeta } from "./channel-base.js";
import { startQaGatewayAccount } from "./gateway.js";
import { sendQaChannelMedia, sendQaChannelMediaBatch, sendQaChannelText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { qaChannelStatus } from "./status.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

type QaChannelPayloadSendContext = Pick<
  ChannelMessageSendPayloadContext,
  | "cfg"
  | "to"
  | "text"
  | "payload"
  | "accountId"
  | "threadId"
  | "replyToId"
  | "mediaUrl"
  | "mediaAccess"
  | "mediaLocalRoots"
  | "mediaReadFile"
>;

function createQaChannelMessageReceipt(
  ctx: Pick<QaChannelPayloadSendContext, "replyToId" | "threadId" | "to">,
  messageId: string,
  kind: "media" | "text",
) {
  const { threadId } = resolveQaTargetThread({ target: ctx.to, threadId: ctx.threadId });
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: QA_CHANNEL_ID, messageId }],
    threadId,
    replyToId: ctx.replyToId ?? undefined,
    kind,
  });
}

async function sendQaChannelMessagePayload(ctx: QaChannelPayloadSendContext) {
  const text = ctx.payload.text ?? ctx.text;
  const mediaUrls = Array.from(
    new Set(
      [ctx.mediaUrl, ctx.payload.mediaUrl, ...(ctx.payload.mediaUrls ?? [])].filter(
        (mediaUrl): mediaUrl is string =>
          typeof mediaUrl === "string" && mediaUrl.trim().length > 0,
      ),
    ),
  );
  const params = {
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.accountId,
    to: ctx.to,
    text,
    isError: ctx.payload.isError,
    threadId: ctx.threadId,
    replyToId: ctx.replyToId,
  };
  const result =
    mediaUrls.length === 0
      ? await sendQaChannelText(params)
      : await sendQaChannelMediaBatch({
          ...params,
          mediaUrls,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
        });
  return {
    messageId: result.messageId,
    receipt: createQaChannelMessageReceipt(
      ctx,
      result.messageId,
      mediaUrls.length > 0 ? "media" : "text",
    ),
  };
}

const qaChannelMessageAdapter = defineChannelMessageAdapter({
  id: QA_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    // Detached completions must deliver the visible caption and media atomically.
    payload: sendQaChannelMessagePayload,
    text: async (ctx) => {
      const result = await sendQaChannelText({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
      return {
        messageId: result.messageId,
        receipt: createQaChannelMessageReceipt(ctx, result.messageId, "text"),
      };
    },
    media: async (ctx) => {
      const result = await sendQaChannelMedia({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
      return {
        messageId: result.messageId,
        receipt: createQaChannelMessageReceipt(ctx, result.messageId, "media"),
      };
    },
  },
});

const qaChannelPluginBase = createQaChannelPluginBase(qaChannelRuntimeMeta);

function matchesQaToolContextTarget(target: string, toolContext: ChannelThreadingToolContext) {
  // Native source identity wins when To describes a different conversation.
  const currentTarget = toolContext.currentChannelId || toolContext.currentMessagingTarget;
  if (
    !currentTarget ||
    (toolContext.currentChannelProvider && toolContext.currentChannelProvider !== QA_CHANNEL_ID)
  ) {
    return false;
  }
  // Message-action bare targets mean channels; the source kind cannot reinterpret them.
  const requested = parseQaTarget(target, { defaultChatType: "channel" });
  const current = parseQaTarget(currentTarget, {
    defaultChatType: toolContext.currentChatType ?? requested.chatType,
  });
  return (
    current.chatType === requested.chatType &&
    current.conversationId === requested.conversationId &&
    (!requested.threadId ||
      requested.threadId === (toolContext.currentThreadTs ?? current.threadId))
  );
}

export const qaChannelPlugin: ChannelPlugin<ResolvedQaChannelAccount> = createChatChannelPlugin({
  base: {
    ...qaChannelPluginBase,
    capabilities: { ...qaChannelPluginBase.capabilities, media: true },
    messaging: {
      normalizeTarget: normalizeQaTarget,
      inferTargetChatType: ({ to }) => parseQaTarget(to).chatType,
      targetResolver: {
        looksLikeId: (raw) =>
          /^((dm|channel|group):|thread:[^/]+\/)/i.test(raw.trim()) || raw.trim().length > 0,
        hint: "<dm:user|channel:room|group:room|thread:room/thread>",
      },
      resolveOutboundSessionRoute: ({
        cfg,
        agentId,
        accountId,
        target,
        replyToId,
        threadId,
        currentSessionKey,
      }) => {
        const resolved = resolveQaTargetThread({ target, threadId });
        const parsed = resolved.target;
        const baseRoute = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: QA_CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: {
            kind:
              parsed.chatType === "direct"
                ? "direct"
                : parsed.chatType === "group"
                  ? "group"
                  : "channel",
            id: buildQaTarget(parsed),
          },
          chatType: parsed.chatType,
          from: `${QA_CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: buildQaTarget(parsed),
        });
        // An explicit thread target already owns the complete session identity;
        // applying reply or current-thread metadata would append a second thread.
        if (parsed.threadId !== undefined) {
          return baseRoute;
        }
        return buildThreadAwareOutboundSessionRoute({
          route: baseRoute,
          replyToId,
          threadId: resolved.threadId,
          currentSessionKey,
          canRecoverCurrentThread: ({ route }) =>
            route.chatType !== "direct" || (cfg.session?.dmScope ?? "main") !== "main",
        });
      },
      resolveSessionConversation: ({ rawId }) => {
        const parsed = parseQaTarget(rawId);
        if (parsed.chatType === "direct") {
          return null;
        }
        return {
          id: parsed.conversationId,
          threadId: parsed.threadId,
          baseConversationId: parsed.conversationId,
          parentConversationCandidates: [parsed.conversationId],
        };
      },
    },
    status: qaChannelStatus,
    gateway: {
      startAccount: async (ctx) => {
        await startQaGatewayAccount(QA_CHANNEL_ID, qaChannelRuntimeMeta.label, ctx);
      },
    },
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) =>
        matchesQaToolContextTarget(target, toolContext),
      resolveAutoThreadId: ({ to, toolContext }) =>
        toolContext?.currentThreadTs &&
        !parseQaTarget(to).threadId &&
        matchesQaToolContextTarget(to, toolContext)
          ? toolContext.currentThreadTs
          : undefined,
      buildToolContext: ({ context, hasRepliedRef }) => {
        const currentMessagingTarget = context.To?.trim() || undefined;
        const chatType =
          context.ChatType === "direct" ||
          context.ChatType === "group" ||
          context.ChatType === "channel"
            ? context.ChatType
            : undefined;
        const parsedTarget = currentMessagingTarget
          ? parseQaTarget(currentMessagingTarget, {
              defaultChatType: chatType ?? "channel",
            })
          : undefined;
        const nativeChannelId = context.NativeChannelId?.trim() || undefined;
        const currentThreadTs =
          context.MessageThreadId != null
            ? String(context.MessageThreadId)
            : parsedTarget?.threadId;
        return {
          // Implicit actions need a typed root; embedding To's thread would
          // bypass topLevel/threadId:null opt-outs.
          currentChannelId: parsedTarget
            ? buildQaTarget({
                chatType: parsedTarget.chatType,
                conversationId: nativeChannelId || parsedTarget.conversationId,
              })
            : nativeChannelId,
          currentChatType: chatType ?? parsedTarget?.chatType,
          currentMessagingTarget,
          currentThreadTs,
          ...(currentThreadTs ? { replyToMode: "all" as const } : {}),
          hasRepliedRef,
        };
      },
    },
    actions: qaChannelMessageActions,
    message: qaChannelMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      sendTextOnlyErrorPayloads: true,
      sendPayload: async (ctx) => {
        const result = await sendQaChannelMessagePayload(ctx);
        return { channel: QA_CHANNEL_ID, messageId: result.messageId };
      },
    },
    attachedResults: {
      channel: QA_CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) =>
        await sendQaChannelText({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
          threadId,
          replyToId,
        }),
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        accountId,
        threadId,
        replyToId,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
      }) => {
        if (!mediaUrl) {
          throw new Error("QA channel media send requires mediaUrl");
        }
        return await sendQaChannelMedia({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
          mediaUrl,
          threadId,
          replyToId,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
        });
      },
    },
  },
});
