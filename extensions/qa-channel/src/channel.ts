import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-message";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
} from "./accounts.js";
import { buildQaTarget, normalizeQaTarget, parseQaTarget } from "./bus-client.js";
import { qaChannelMessageActions } from "./channel-actions.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import { startQaGatewayAccount } from "./gateway.js";
import { sendQaChannelText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup } from "./setup.js";
import { qaChannelStatus } from "./status.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

const CHANNEL_ID = "qa-channel" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

const qaChannelMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
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
          results: [{ channel: CHANNEL_ID, messageId: result.messageId }],
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
    id: CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    reload: { configPrefixes: ["channels.qa-channel"] },
    configSchema: qaChannelPluginConfigSchema,
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applyQaSetup({
          cfg,
          accountId,
          input: input as Record<string, unknown>,
        }),
    },
    config: {
      listAccountIds: (cfg) => listQaChannelAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultQaChannelAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
    },
    messaging: {
      normalizeTarget: normalizeQaTarget,
      parseExplicitTarget: ({ raw }) => {
        const parsed = parseQaTarget(raw);
        return {
          to: buildQaTarget(parsed),
          threadId: parsed.threadId,
          chatType: parsed.chatType,
        };
      },
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
          channel: CHANNEL_ID,
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
          from: `qa-channel:${accountId ?? DEFAULT_ACCOUNT_ID}`,
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
        await startQaGatewayAccount(CHANNEL_ID, meta.label, ctx);
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
      channel: CHANNEL_ID,
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
