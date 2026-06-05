// Qa Channel plugin module implements channel behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { buildQaTarget, normalizeQaTarget, parseQaTarget } from "./bus-client.js";
import { qaChannelMessageActions } from "./channel-actions.js";
import { createQaChannelPluginBase, QA_CHANNEL_ID, qaChannelRuntimeMeta } from "./channel-base.js";
import { startQaGatewayAccount } from "./gateway.js";
import { sendQaChannelText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { qaChannelStatus } from "./status.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

const qaChannelMessageAdapter = defineChannelMessageAdapter({
  id: QA_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendQaChannelText({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
      const threadId = ctx.threadId == null ? undefined : String(ctx.threadId);
      const replyToId = ctx.replyToId ?? undefined;
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: QA_CHANNEL_ID, messageId: result.messageId }],
          threadId,
          replyToId,
          kind: "text",
        }),
      };
    },
  },
});

export const qaChannelPlugin: ChannelPlugin<ResolvedQaChannelAccount> = createChatChannelPlugin({
  base: {
    ...createQaChannelPluginBase(qaChannelRuntimeMeta),
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
        const parsed = parseQaTarget(target);
        const baseRoute = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: QA_CHANNEL_ID,
          accountId,
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
        return buildThreadAwareOutboundSessionRoute({
          route: baseRoute,
          replyToId,
          threadId: threadId ?? (target.trim().startsWith("thread:") ? undefined : parsed.threadId),
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
    actions: qaChannelMessageActions,
    message: qaChannelMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
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
    },
  },
});
