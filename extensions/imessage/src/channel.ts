import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-message";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveIMessageAccount, type ResolvedIMessageAccount } from "./accounts.js";
import { imessageMessageActions } from "./actions.js";
import {
  chunkTextForOutbound,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatTrimmedAllowFromEntries,
  normalizeIMessageMessagingTarget,
  type ChannelPlugin,
} from "./channel-api.js";
import { createIMessageConversationBindingManager } from "./conversation-bindings.js";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
  resolveIMessageConversationIdFromTarget,
} from "./conversation-id.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { sanitizeOutboundText } from "./monitor/sanitize-outbound.js";
import type { IMessageProbe } from "./probe.js";
import { imessageSetupAdapter } from "./setup-core.js";
import {
  createIMessagePluginBase,
  imessageSecurityAdapter,
  imessageSetupWizard,
} from "./shared.js";
import { probeIMessageStatusAccount } from "./status-core.js";
import {
  inferIMessageTargetChatType,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const loadIMessageChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

type IMessageMessageContextExtras = {
  deps?: { [channelId: string]: unknown };
};

function toIMessageMessageSendResult(
  result: { messageId?: string; receipt?: ChannelMessageSendResult["receipt"] },
  kind: MessageReceiptPartKind,
  replyToId?: string | null,
): ChannelMessageSendResult {
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId ? [{ channel: "imessage", messageId: result.messageId }] : [],
      kind,
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

const imessageMessageAdapter = defineChannelMessageAdapter({
  id: "imessage",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await (
        await loadIMessageChannelRuntime()
      ).sendIMessageOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & IMessageMessageContextExtras).deps,
        replyToId: ctx.replyToId ?? undefined,
      });
      return toIMessageMessageSendResult(result, "text", ctx.replyToId);
    },
    media: async (ctx) => {
      const result = await (
        await loadIMessageChannelRuntime()
      ).sendIMessageOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & IMessageMessageContextExtras).deps,
        replyToId: ctx.replyToId ?? undefined,
      });
      return toIMessageMessageSendResult(result, "media", ctx.replyToId);
    },
  },
});

function buildIMessageBaseSessionKey(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "imessage" });
}

function resolveIMessageOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const parsed = parseIMessageTarget(params.target);
  if (parsed.kind === "handle") {
    const handle = normalizeIMessageHandle(parsed.to);
    if (!handle) {
      return null;
    }
    const peer: RoutePeer = { kind: "direct", id: handle };
    const baseSessionKey = buildIMessageBaseSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      accountId: params.accountId,
      peer,
    });
    return {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: "direct" as const,
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
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: "group", id: peerId };
  const baseSessionKey = buildIMessageBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
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
    chatType: "group" as const,
    from: `imessage:group:${peerId}`,
    to: `${toPrefix}:${peerId}`,
  };
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount, IMessageProbe> =
  createChatChannelPlugin<ResolvedIMessageAccount, IMessageProbe>({
    base: {
      ...createIMessagePluginBase({
        setupWizard: imessageSetupWizard,
        setup: imessageSetupAdapter,
      }),
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "imessage",
        resolveAccount: resolveIMessageAccount,
        normalize: ({ values }) => formatTrimmedAllowFromEntries(values),
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      groups: {
        resolveRequireMention: resolveIMessageGroupRequireMention,
        resolveToolPolicy: resolveIMessageGroupToolPolicy,
      },
      doctor: {
        groupAllowFromFallbackToAllowFrom: false,
      },
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        createManager: ({ cfg, accountId }) =>
          createIMessageConversationBindingManager({
            cfg,
            accountId: accountId ?? undefined,
          }),
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeIMessageAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId }) =>
          matchIMessageAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
          }),
        resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
          const conversationId =
            resolveIMessageConversationIdFromTarget(originatingTo ?? "") ??
            resolveIMessageConversationIdFromTarget(commandTo ?? "") ??
            resolveIMessageConversationIdFromTarget(fallbackTo ?? "");
          return conversationId ? { conversationId } : null;
        },
      },
      messaging: {
        normalizeTarget: normalizeIMessageMessagingTarget,
        inferTargetChatType: ({ to }) => inferIMessageTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveIMessageOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeIMessageExplicitTargetId,
          hint: "<handle|chat_id:ID>",
          resolveTarget: async ({ normalized }) => {
            const to = normalized?.trim();
            if (!to) {
              return null;
            }
            const chatType = inferIMessageTargetChatType(to);
            if (!chatType) {
              return null;
            }
            return {
              to,
              kind: chatType === "direct" ? "user" : "group",
              source: "normalized" as const,
            };
          },
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedIMessageAccount, IMessageProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          cliPath: null,
          dbPath: null,
        }),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveProbedChannelStatusSummary(snapshot, {
            cliPath: snapshot.cliPath ?? null,
            dbPath: snapshot.dbPath ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) =>
          await probeIMessageStatusAccount({
            account,
            timeoutMs,
            probeIMessageAccount: async (params) =>
              await (await loadIMessageChannelRuntime()).probeIMessageAccount(params),
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
            dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
          },
        }),
        resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const conversationBindings = createIMessageConversationBindingManager({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
          });
          try {
            return await (await loadIMessageChannelRuntime()).startIMessageGatewayAccount(ctx);
          } finally {
            conversationBindings.stop();
          }
        },
      },
      message: imessageMessageAdapter,
      actions: imessageMessageActions,
    },
    pairing: {
      text: {
        idLabel: "imessageSenderId",
        message: "OpenClaw: your access has been approved.",
        notify: async ({ id, cfg }) =>
          await (await loadIMessageChannelRuntime()).notifyIMessageApproval({ id, cfg }),
      },
    },
    security: imessageSecurityAdapter,
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: chunkTextForOutbound,
        chunkerMode: "text",
        textChunkLimit: 4000,
        sanitizeText: ({ text }) => sanitizeForPlainText(sanitizeOutboundText(text)),
        deliveryCapabilities: {
          durableFinal: {
            text: true,
            media: true,
            replyTo: true,
            messageSendingHooks: true,
          },
        },
      },
      attachedResults: {
        channel: "imessage",
        sendText: async ({ cfg, to, text, accountId, deps, replyToId }) =>
          await (
            await loadIMessageChannelRuntime()
          ).sendIMessageOutbound({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            deps,
            replyToId: replyToId ?? undefined,
          }),
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          accountId,
          deps,
          replyToId,
        }) =>
          await (
            await loadIMessageChannelRuntime()
          ).sendIMessageOutbound({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            accountId: accountId ?? undefined,
            deps,
            replyToId: replyToId ?? undefined,
          }),
      },
    },
  });
