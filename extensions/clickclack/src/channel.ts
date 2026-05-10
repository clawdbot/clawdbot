import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-message";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import { clickClackConfigSchema } from "./config-schema.js";
import { startClickClackGatewayAccount } from "./gateway.js";
import { sendClickClackText } from "./outbound.js";
import {
  buildClickClackTarget,
  looksLikeClickClackTarget,
  parseClickClackTarget,
  normalizeClickClackTarget,
} from "./target.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

const clickClackMessageAdapter = defineChannelMessageAdapter({
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
      const result = await sendClickClackText({
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

export const clickClackPlugin: ChannelPlugin<ResolvedClickClackAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
      threads: true,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.clickclack"] },
    configSchema: clickClackConfigSchema,
    config: {
      listAccountIds: (cfg) => listClickClackAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultClickClackAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
    },
    messaging: {
      targetPrefixes: ["clickclack", "cc"],
      normalizeTarget: normalizeClickClackTarget,
      parseExplicitTarget: ({ raw }) => {
        const parsed = parseClickClackTarget(raw);
        return {
          to: buildClickClackTarget(parsed),
          threadId: parsed.kind === "thread" ? parsed.id : undefined,
          chatType: parsed.chatType,
        };
      },
      inferTargetChatType: ({ to }) => parseClickClackTarget(to).chatType,
      targetResolver: {
        looksLikeId: looksLikeClickClackTarget,
        hint: "<channel:name|dm:usr_id|thread:msg_id>",
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
        const parsed = parseClickClackTarget(target);
        const baseRoute = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: parsed.chatType === "direct" ? "direct" : "channel",
            id: buildClickClackTarget(parsed),
          },
          chatType: parsed.chatType,
          from: `clickclack:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: buildClickClackTarget(parsed),
        });
        return buildThreadAwareOutboundSessionRoute({
          route: baseRoute,
          replyToId,
          threadId: threadId ?? (parsed.kind === "thread" ? parsed.id : undefined),
          currentSessionKey,
          canRecoverCurrentThread: () => true,
        });
      },
      resolveSessionConversation: ({ rawId }) => {
        const parsed = parseClickClackTarget(rawId);
        if (parsed.kind === "dm") {
          return null;
        }
        return {
          id: parsed.id,
          threadId: parsed.kind === "thread" ? parsed.id : undefined,
          baseConversationId: parsed.id,
          parentConversationCandidates: [parsed.id],
        };
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedClickClackAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) => ({
        ok: snapshot.configured,
        label: snapshot.configured ? "configured" : "missing config",
        detail: snapshot.baseUrl ?? "",
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
      }),
    }),
    gateway: {
      startAccount: startClickClackGatewayAccount,
    },
    message: clickClackMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) =>
        await sendClickClackText({
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
