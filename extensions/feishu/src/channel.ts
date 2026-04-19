import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createMessageToolCardSchema } from "openclaw/plugin-sdk/channel-actions";
import {
  adaptScopedAccountAccessor,
  createHybridChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  projectConfigAccountIdWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  inspectFeishuCredentials,
  listEnabledFeishuAccounts,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { feishuApprovalAuth } from "./approval-auth.js";
import { FEISHU_CARD_INTERACTION_VERSION } from "./card-interaction.js";
import type {
  ChannelMessageActionName,
  ChannelMeta,
  ChannelPlugin,
  ClawdbotConfig,
} from "./channel-runtime-api.js";
import {
  buildChannelConfigSchema,
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createActionGate,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "./channel-runtime-api.js";
import { createFeishuClient } from "./client.js";
import { isRecord } from "./comment-shared.js";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  buildFeishuConversationId,
  buildFeishuModelOverrideParentCandidates,
  parseFeishuConversationId,
  parseFeishuDirectConversationId,
  parseFeishuTargetId,
} from "./conversation-id.js";
import { listFeishuDirectoryGroups, listFeishuDirectoryPeers } from "./directory.static.js";
import { messageActionTargetAliases } from "./message-action-contract.js";
import { resolveFeishuGroupToolPolicy } from "./policy.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { collectFeishuSecurityAuditFindings } from "./security-audit.js";
import { resolveFeishuSessionConversation } from "./session-conversation.js";
import { resolveFeishuOutboundSessionRoute } from "./session-route.js";
import { feishuSetupAdapter } from "./setup-core.js";
import { feishuSetupWizard, runFeishuLogin } from "./setup-surface.js";
import { looksLikeFeishuId, normalizeFeishuTarget } from "./targets.js";
import type { FeishuConfig, FeishuProbeResult, ResolvedFeishuAccount } from "./types.js";

function readFeishuMediaParam(params: Record<string, unknown>): string | undefined {
  const media = params.media;
  if (typeof media !== "string") {
    return undefined;
  }
  return media.trim() ? media : undefined;
}

function hasLegacyFeishuCardCommandValue(actionValue: unknown): boolean {
  return (
    isRecord(actionValue) &&
    actionValue.oc !== FEISHU_CARD_INTERACTION_VERSION &&
    (Boolean(typeof actionValue.command === "string" && actionValue.command.trim()) ||
      Boolean(typeof actionValue.text === "string" && actionValue.text.trim()))
  );
}

function containsLegacyFeishuCardCommandValue(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => containsLegacyFeishuCardCommandValue(item));
  }
  if (!isRecord(node)) {
    return false;
  }

  if (node.tag === "button" && hasLegacyFeishuCardCommandValue(node.value)) {
    return true;
  }

  return Object.values(node).some((value) => containsLegacyFeishuCardCommandValue(value));
}

const meta: ChannelMeta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu/Lark (飞书)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "飞书/Lark enterprise messaging.",
  aliases: ["lark"],
  order: 70,
};

const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "feishuChannelRuntime",
);

const collectFeishuSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: ClawdbotConfig;
  accountId?: string | null;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.feishu !== undefined,
  resolveGroupPolicy: ({ cfg, accountId }) =>
    resolveFeishuAccount({ cfg, accountId }).config?.groupPolicy,
  collect: ({ cfg, accountId, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const account = resolveFeishuAccount({ cfg, accountId });
    return [
      `- Feishu[${account.accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.`,
    ];
  },
});

function describeFeishuMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = accountId
    ? [resolveFeishuAccount({ cfg, accountId })].filter(
        (account) => account.enabled && account.configured,
      )
    : listEnabledFeishuAccounts(cfg);
  const enabled =
    enabledAccounts.length > 0 ||
    (!accountId &&
      cfg.channels?.feishu?.enabled !== false &&
      Boolean(inspectFeishuCredentials(cfg.channels?.feishu as FeishuConfig | undefined)));
  if (enabledAccounts.length === 0) {
    return {
      actions: [],
      capabilities: enabled ? ["cards"] : [],
      schema: enabled
        ? {
            properties: {
              card: createMessageToolCardSchema(),
            },
          }
        : null,
    };
  }
  const actions = new Set<ChannelMessageActionName>([
    "send",
    "read",
    "edit",
    "thread-reply",
    "pin",
    "list-pins",
    "unpin",
    "member-info",
    "channel-info",
    "channel-list",
  ]);
  if (
    accountId
      ? enabledAccounts.some((account) => isFeishuReactionsActionEnabled({ cfg, account }))
      : areAnyFeishuReactionActionsEnabled(cfg)
  ) {
    actions.add("react");
    actions.add("reactions");
  }
  return {
    actions: Array.from(actions),
    capabilities: enabled ? ["cards"] : [],
    schema: enabled
      ? {
          properties: {
            card: createMessageToolCardSchema(),
          },
        }
      : null,
  };
}

function setFeishuNamedAccountEnabled(
  cfg: ClawdbotConfig,
  accountId: string,
  enabled: boolean,
): ClawdbotConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: {
          ...feishuCfg?.accounts,
          [accountId]: {
            ...feishuCfg?.accounts?.[accountId],
            enabled,
          },
        },
      },
    },
  };
}

const feishuConfigAdapter = createHybridChannelConfigAdapter<
  ResolvedFeishuAccount,
  ResolvedFeishuAccount
>({
  sectionKey: "feishu",
  listAccountIds: listFeishuAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveFeishuAccount),
  defaultAccountId: resolveDefaultFeishuAccountId,
  clearBaseFields: [],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
});

function isFeishuReactionsActionEnabled(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
}): boolean {
  if (!params.account.enabled || !params.account.configured) {
    return false;
  }
  const gate = createActionGate(
    (params.account.config.actions ??
      (params.cfg.channels?.feishu as { actions?: unknown } | undefined)?.actions) as Record<
      string,
      boolean | undefined
    >,
  );
  return gate("reactions");
}

function areAnyFeishuReactionActionsEnabled(cfg: ClawdbotConfig): boolean {
  for (const account of listEnabledFeishuAccounts(cfg)) {
    if (isFeishuReactionsActionEnabled({ cfg, account })) {
      return true;
    }
  }
  return false;
}

function isSupportedFeishuDirectConversationId(conversationId: string): boolean {
  const trimmed = conversationId.trim();
  if (!trimmed || trimmed.includes(":")) {
    return false;
  }
  if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) {
    return false;
  }
  return true;
}

function normalizeFeishuAcpConversationId(conversationId: string) {
  const parsed = parseFeishuConversationId({ conversationId });
  if (
    !parsed ||
    (parsed.scope !== "group_topic" &&
      parsed.scope !== "group_topic_sender" &&
      !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId))
  ) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId:
      parsed.scope === "group_topic" || parsed.scope === "group_topic_sender"
        ? parsed.chatId
        : undefined,
  };
}

function matchFeishuAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeFeishuAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseFeishuConversationId({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (
    !incoming ||
    (incoming.scope !== "group_topic" &&
      incoming.scope !== "group_topic_sender" &&
      !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId))
  ) {
    return null;
  }
  const matchesCanonicalConversation = binding.conversationId === incoming.canonicalConversationId;
  const matchesParentTopicForSenderScopedConversation =
    incoming.scope === "group_topic_sender" &&
    binding.parentConversationId === incoming.chatId &&
    binding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
  if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) {
    return null;
  }
  return {
    conversationId: matchesParentTopicForSenderScopedConversation
      ? binding.conversationId
      : incoming.canonicalConversationId,
    parentConversationId:
      incoming.scope === "group_topic" || incoming.scope === "group_topic_sender"
        ? incoming.chatId
        : undefined,
    matchPriority: matchesCanonicalConversation ? 2 : 1,
  };
}

function resolveFeishuSenderScopedCommandConversation(params: {
  accountId: string;
  parentConversationId?: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
}): string | undefined {
  const parentConversationId = params.parentConversationId?.trim();
  const threadId = params.threadId?.trim();
  const senderId = params.senderId?.trim();
  if (!parentConversationId || !threadId || !senderId) {
    return undefined;
  }
  const expectedScopePrefix = `feishu:group:${normalizeLowercaseStringOrEmpty(parentConversationId)}:topic:${normalizeLowercaseStringOrEmpty(threadId)}:sender:`;
  const isSenderScopedSession = [params.sessionKey, params.parentSessionKey].some((candidate) => {
    const normalized = normalizeLowercaseStringOrEmpty(candidate ?? "");
    if (!normalized) {
      return false;
    }
    const scopedRest = normalized.replace(/^agent:[^:]+:/, "");
    return scopedRest.startsWith(expectedScopePrefix);
  });
  const senderScopedConversationId = buildFeishuConversationId({
    chatId: parentConversationId,
    scope: "group_topic_sender",
    topicId: threadId,
    senderOpenId: senderId,
  });
  if (isSenderScopedSession) {
    return senderScopedConversationId;
  }
  if (!params.sessionKey?.trim()) {
    return undefined;
  }
  const boundConversation = getSessionBindingService()
    .listBySession(params.sessionKey)
    .find((binding) => {
      if (
        binding.conversation.channel !== "feishu" ||
        binding.conversation.accountId !== params.accountId
      ) {
        return false;
      }
      return binding.conversation.conversationId === senderScopedConversationId;
    });
  return boundConversation?.conversation.conversationId;
}

function resolveFeishuCommandConversation(params: {
  accountId: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  if (params.threadId) {
    const parentConversationId =
      parseFeishuTargetId(params.originatingTo) ??
      parseFeishuTargetId(params.commandTo) ??
      parseFeishuTargetId(params.fallbackTo);
    if (!parentConversationId) {
      return null;
    }
    const senderScopedConversationId = resolveFeishuSenderScopedCommandConversation({
      accountId: params.accountId,
      parentConversationId,
      threadId: params.threadId,
      senderId: params.senderId,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
    return {
      conversationId:
        senderScopedConversationId ??
        buildFeishuConversationId({
          chatId: parentConversationId,
          scope: "group_topic",
          topicId: params.threadId,
        }),
      parentConversationId,
    };
  }
  const conversationId =
    parseFeishuDirectConversationId(params.originatingTo) ??
    parseFeishuDirectConversationId(params.commandTo) ??
    parseFeishuDirectConversationId(params.fallbackTo);
  return conversationId ? { conversationId } : null;
}

function jsonActionResult(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function readOptionalNumber(params: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function resolveFeishuActionTarget(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}

function resolveFeishuChatId(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  const raw = readFirstString(
    ctx.params,
    ["chatId", "chat_id", "channelId", "channel_id", "to", "target"],
    ctx.toolContext?.currentChannelId,
  );
  if (!raw) {
    return undefined;
  }
  if (/^(user|dm|open_id):/i.test(raw)) {
    return undefined;
  }
  if (/^(chat|group|channel):/i.test(raw)) {
    return normalizeFeishuTarget(raw) ?? undefined;
  }
  return raw;
}

function resolveFeishuMessageId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["messageId", "message_id", "replyTo", "reply_to"]);
}

function resolveFeishuMemberId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, [
    "memberId",
    "member_id",
    "userId",
    "user_id",
    "openId",
    "open_id",
    "unionId",
    "union_id",
  ]);
}

function resolveFeishuMemberIdType(
  params: Record<string, unknown>,
): "open_id" | "user_id" | "union_id" {
  const raw = readFirstString(params, [
    "memberIdType",
    "member_id_type",
    "userIdType",
    "user_id_type",
  ]);
  if (raw === "open_id" || raw === "user_id" || raw === "union_id") {
    return raw;
  }
  if (
    readFirstString(params, ["userId", "user_id"]) &&
    !readFirstString(params, ["openId", "open_id", "unionId", "union_id"])
  ) {
    return "user_id";
  }
  if (
    readFirstString(params, ["unionId", "union_id"]) &&
    !readFirstString(params, ["openId", "open_id"])
  ) {
    return "union_id";
  }
  return "open_id";
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount, FeishuProbeResult> =
  createChatChannelPlugin({
    base: {
      id: "feishu",
      meta: {
        ...meta,
      },
      capabilities: {
        chatTypes: ["direct", "channel"],
        polls: false,
        threads: true,
        media: true,
        reactions: true,
        edit: true,
        reply: true,
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
          "- Feishu supports interactive cards plus native image, file, audio, and video/media delivery.",
          "- Feishu supports `send`, `read`, `edit`, `thread-reply`, pins, and channel/member lookup, plus reactions when enabled.",
        ],
      },
      groups: {
        resolveToolPolicy: resolveFeishuGroupToolPolicy,
      },
      conversationBindings: {
        defaultTopLevelPlacement: "current",
        buildModelOverrideParentCandidates: ({ parentConversationId }) =>
          buildFeishuModelOverrideParentCandidates(parentConversationId),
      },
      mentions: {
        stripPatterns: () => ['<at user_id="[^"]*">[^<]*</at>'],
      },
      reload: { configPrefixes: ["channels.feishu"] },
      configSchema: buildChannelConfigSchema(FeishuConfigSchema),
      config: {
        ...feishuConfigAdapter,
        setAccountEnabled: ({ cfg, accountId, enabled }) => {
          const isDefault = accountId === DEFAULT_ACCOUNT_ID;
          if (isDefault) {
            return {
              ...cfg,
              channels: {
                ...cfg.channels,
                feishu: {
                  ...cfg.channels?.feishu,
                  enabled,
                },
              },
            };
          }
          return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
        },
        deleteAccount: ({ cfg, accountId }) => {
          const isDefault = accountId === DEFAULT_ACCOUNT_ID;

          if (isDefault) {
            // Delete entire feishu config
            const next = { ...cfg } as ClawdbotConfig;
            const nextChannels = { ...cfg.channels };
            delete (nextChannels as Record<string, unknown>).feishu;
            if (Object.keys(nextChannels).length > 0) {
              next.channels = nextChannels;
            } else {
              delete next.channels;
            }
            return next;
          }

          // Delete specific account from accounts
          const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
          const accounts = { ...feishuCfg?.accounts };
          delete accounts[accountId];

          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              feishu: {
                ...feishuCfg,
                accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
              },
            },
          };
        },
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              appId: account.appId,
              domain: account.domain,
            },
          }),
      },
      approvalCapability: feishuApprovalAuth,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      actions: {
        messageActionTargetAliases,
        describeMessageTool: describeFeishuMessageTool,
        handleAction: async (ctx) => {
          const account = resolveFeishuAccount({
            cfg: ctx.cfg,
            accountId: ctx.accountId ?? undefined,
          });
          if (
            (ctx.action === "react" || ctx.action === "reactions") &&
            !isFeishuReactionsActionEnabled({ cfg: ctx.cfg, account })
          ) {
            throw new Error("Feishu reactions are disabled via actions.reactions.");
          }
          if (ctx.action === "send" || ctx.action === "thread-reply") {
            const to = resolveFeishuActionTarget(ctx);
            if (!to) {
              throw new Error(`Feishu ${ctx.action} requires a target (to).`);
            }
            const replyToMessageId =
              ctx.action === "thread-reply" ? resolveFeishuMessageId(ctx.params) : undefined;
            if (ctx.action === "thread-reply" && !replyToMessageId) {
              throw new Error("Feishu thread-reply requires messageId.");
            }
            const card =
              ctx.params.card && typeof ctx.params.card === "object"
                ? (ctx.params.card as Record<string, unknown>)
                : undefined;
            const text = readFirstString(ctx.params, ["text", "message"]);
            const mediaUrl = readFeishuMediaParam(ctx.params);
            if (card && mediaUrl) {
              throw new Error(`Feishu ${ctx.action} does not support card with media.`);
            }
            if (!card && !text && !mediaUrl) {
              throw new Error(`Feishu ${ctx.action} requires text/message, media, or card.`);
            }
            const runtime = await loadFeishuChannelRuntime();
            const maybeSendMedia = runtime.feishuOutbound.sendMedia;
            if (mediaUrl && !maybeSendMedia) {
              throw new Error("Feishu media sending is not available.");
            }
            const sendMedia = maybeSendMedia;
            let result;
            if (card) {
              if (containsLegacyFeishuCardCommandValue(card)) {
                throw new Error(
                  "Feishu card buttons that trigger text or commands must use structured interaction envelopes.",
                );
              }
              result = await runtime.sendCardFeishu({
                cfg: ctx.cfg,
                to,
                card,
                accountId: ctx.accountId ?? undefined,
                replyToMessageId,
                replyInThread: ctx.action === "thread-reply",
              });
            } else if (mediaUrl) {
              result = await sendMedia!({
                cfg: ctx.cfg,
                to,
                text: text ?? "",
                mediaUrl,
                accountId: ctx.accountId ?? undefined,
                mediaLocalRoots: ctx.mediaLocalRoots,
                replyToId: replyToMessageId,
              });
            } else {
              result = await runtime.sendMessageFeishu({
                cfg: ctx.cfg,
                to,
                text: text!,
                accountId: ctx.accountId ?? undefined,
                replyToMessageId,
                replyInThread: ctx.action === "thread-reply",
              });
            }
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: ctx.action,
              ...result,
            });
          }

          if (ctx.action === "read") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu read requires messageId.");
            }
            const { getMessageFeishu } = await loadFeishuChannelRuntime();
            const message = await getMessageFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            if (!message) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error: `Feishu read failed or message not found: ${messageId}`,
                    }),
                  },
                ],
                details: { error: `Feishu read failed or message not found: ${messageId}` },
              };
            }
            return jsonActionResult({ ok: true, channel: "feishu", action: "read", message });
          }

          if (ctx.action === "edit") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu edit requires messageId.");
            }
            const text = readFirstString(ctx.params, ["text", "message"]);
            const card =
              ctx.params.card && typeof ctx.params.card === "object"
                ? (ctx.params.card as Record<string, unknown>)
                : undefined;
            const { editMessageFeishu } = await loadFeishuChannelRuntime();
            const result = await editMessageFeishu({
              cfg: ctx.cfg,
              messageId,
              text,
              card,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "edit",
              ...result,
            });
          }

          if (ctx.action === "pin") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu pin requires messageId.");
            }
            const { createPinFeishu } = await loadFeishuChannelRuntime();
            const pin = await createPinFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, channel: "feishu", action: "pin", pin });
          }

          if (ctx.action === "unpin") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu unpin requires messageId.");
            }
            const { removePinFeishu } = await loadFeishuChannelRuntime();
            await removePinFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "unpin",
              messageId,
            });
          }

          if (ctx.action === "list-pins") {
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu list-pins requires chatId or channelId.");
            }
            const { listPinsFeishu } = await loadFeishuChannelRuntime();
            const result = await listPinsFeishu({
              cfg: ctx.cfg,
              chatId,
              startTime: readFirstString(ctx.params, ["startTime", "start_time"]),
              endTime: readFirstString(ctx.params, ["endTime", "end_time"]),
              pageSize: readOptionalNumber(ctx.params, ["pageSize", "page_size"]),
              pageToken: readFirstString(ctx.params, ["pageToken", "page_token"]),
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "list-pins",
              ...result,
            });
          }

          if (ctx.action === "channel-info") {
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu channel-info requires chatId or channelId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            const client = createFeishuClient(account);
            const channel = await runtime.getChatInfo(client, chatId);
            const includeMembers =
              ctx.params.includeMembers === true || ctx.params.members === true;
            if (!includeMembers) {
              return jsonActionResult({
                ok: true,
                provider: "feishu",
                action: "channel-info",
                channel,
              });
            }
            const members = await runtime.getChatMembers(
              client,
              chatId,
              readOptionalNumber(ctx.params, ["pageSize", "page_size"]),
              readFirstString(ctx.params, ["pageToken", "page_token"]),
              resolveFeishuMemberIdType(ctx.params),
            );
            return jsonActionResult({
              ok: true,
              provider: "feishu",
              action: "channel-info",
              channel,
              members,
            });
          }

          if (ctx.action === "member-info") {
            const runtime = await loadFeishuChannelRuntime();
            const client = createFeishuClient(account);
            const memberId = resolveFeishuMemberId(ctx.params);
            if (memberId) {
              const member = await runtime.getFeishuMemberInfo(
                client,
                memberId,
                resolveFeishuMemberIdType(ctx.params),
              );
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "member-info",
                member,
              });
            }
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu member-info requires memberId or chatId/channelId.");
            }
            const members = await runtime.getChatMembers(
              client,
              chatId,
              readOptionalNumber(ctx.params, ["pageSize", "page_size"]),
              readFirstString(ctx.params, ["pageToken", "page_token"]),
              resolveFeishuMemberIdType(ctx.params),
            );
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "member-info",
              ...members,
            });
          }

          if (ctx.action === "channel-list") {
            const runtime = await loadFeishuChannelRuntime();
            const query = readFirstString(ctx.params, ["query"]);
            const limit = readOptionalNumber(ctx.params, ["limit"]);
            const scope = readFirstString(ctx.params, ["scope", "kind"]) ?? "all";
            if (
              scope === "groups" ||
              scope === "group" ||
              scope === "channels" ||
              scope === "channel"
            ) {
              const groups = await runtime.listFeishuDirectoryGroupsLive({
                cfg: ctx.cfg,
                query,
                limit,
                fallbackToStatic: false,
                accountId: ctx.accountId ?? undefined,
              });
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "channel-list",
                groups,
              });
            }
            if (
              scope === "peers" ||
              scope === "peer" ||
              scope === "members" ||
              scope === "member" ||
              scope === "users" ||
              scope === "user"
            ) {
              const peers = await runtime.listFeishuDirectoryPeersLive({
                cfg: ctx.cfg,
                query,
                limit,
                fallbackToStatic: false,
                accountId: ctx.accountId ?? undefined,
              });
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "channel-list",
                peers,
              });
            }
            const [groups, peers] = await Promise.all([
              runtime.listFeishuDirectoryGroupsLive({
                cfg: ctx.cfg,
                query,
                limit,
                fallbackToStatic: false,
                accountId: ctx.accountId ?? undefined,
              }),
              runtime.listFeishuDirectoryPeersLive({
                cfg: ctx.cfg,
                query,
                limit,
                fallbackToStatic: false,
                accountId: ctx.accountId ?? undefined,
              }),
            ]);
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "channel-list",
              groups,
              peers,
            });
          }

          if (ctx.action === "react") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu reaction requires messageId.");
            }
            const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
            const remove = ctx.params.remove === true;
            const clearAll = ctx.params.clearAll === true;
            if (remove) {
              if (!emoji) {
                throw new Error("Emoji is required to remove a Feishu reaction.");
              }
              const { listReactionsFeishu, removeReactionFeishu } =
                await loadFeishuChannelRuntime();
              const matches = await listReactionsFeishu({
                cfg: ctx.cfg,
                messageId,
                emojiType: emoji,
                accountId: ctx.accountId ?? undefined,
              });
              const ownReaction = matches.find((entry) => entry.operatorType === "app");
              if (!ownReaction) {
                return jsonActionResult({ ok: true, removed: null });
              }
              await removeReactionFeishu({
                cfg: ctx.cfg,
                messageId,
                reactionId: ownReaction.reactionId,
                accountId: ctx.accountId ?? undefined,
              });
              return jsonActionResult({ ok: true, removed: emoji });
            }
            if (!emoji) {
              if (!clearAll) {
                throw new Error(
                  "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
                );
              }
              const { listReactionsFeishu, removeReactionFeishu } =
                await loadFeishuChannelRuntime();
              const reactions = await listReactionsFeishu({
                cfg: ctx.cfg,
                messageId,
                accountId: ctx.accountId ?? undefined,
              });
              let removed = 0;
              for (const reaction of reactions.filter((entry) => entry.operatorType === "app")) {
                await removeReactionFeishu({
                  cfg: ctx.cfg,
                  messageId,
                  reactionId: reaction.reactionId,
                  accountId: ctx.accountId ?? undefined,
                });
                removed += 1;
              }
              return jsonActionResult({ ok: true, removed });
            }
            const { addReactionFeishu } = await loadFeishuChannelRuntime();
            await addReactionFeishu({
              cfg: ctx.cfg,
              messageId,
              emojiType: emoji,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, added: emoji });
          }

          if (ctx.action === "reactions") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu reactions lookup requires messageId.");
            }
            const { listReactionsFeishu } = await loadFeishuChannelRuntime();
            const reactions = await listReactionsFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, reactions });
          }

          throw new Error(`Unsupported Feishu action: "${ctx.action}"`);
        },
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeFeishuAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchFeishuAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: ({
          accountId,
          threadId,
          senderId,
          sessionKey,
          parentSessionKey,
          originatingTo,
          commandTo,
          fallbackTo,
        }) =>
          resolveFeishuCommandConversation({
            accountId,
            threadId,
            senderId,
            sessionKey,
            parentSessionKey,
            originatingTo,
            commandTo,
            fallbackTo,
          }),
      },
      auth: {
        login: async ({ cfg }) => {
          const { createClackPrompter } = await import("openclaw/plugin-sdk/setup-runtime");
          const { writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
          const prompter = createClackPrompter();
          const nextCfg = await runFeishuLogin({ cfg, prompter });
          if (nextCfg !== cfg) {
            await writeConfigFile(nextCfg);
          }
        },
      },
      setup: feishuSetupAdapter,
      setupWizard: feishuSetupWizard,
      messaging: {
        normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? undefined,
        resolveSessionConversation: ({ kind, rawId }) =>
          resolveFeishuSessionConversation({ kind, rawId }),
        resolveOutboundSessionRoute: (params) => resolveFeishuOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeFeishuId,
          hint: "<chatId|user:openId|chat:chatId>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async ({ cfg, query, limit, accountId }) =>
          listFeishuDirectoryPeers({
            cfg,
            query: query ?? undefined,
            limit: limit ?? undefined,
            accountId: accountId ?? undefined,
          }),
        listGroups: async ({ cfg, query, limit, accountId }) =>
          listFeishuDirectoryGroups({
            cfg,
            query: query ?? undefined,
            limit: limit ?? undefined,
            accountId: accountId ?? undefined,
          }),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadFeishuChannelRuntime,
          listPeersLive:
            (runtime) =>
            async ({ cfg, query, limit, accountId }) =>
              await runtime.listFeishuDirectoryPeersLive({
                cfg,
                query: query ?? undefined,
                limit: limit ?? undefined,
                accountId: accountId ?? undefined,
              }),
          listGroupsLive:
            (runtime) =>
            async ({ cfg, query, limit, accountId }) =>
              await runtime.listFeishuDirectoryGroupsLive({
                cfg,
                query: query ?? undefined,
                limit: limit ?? undefined,
                accountId: accountId ?? undefined,
              }),
        }),
      }),
      status: createComputedAccountStatusAdapter<ResolvedFeishuAccount, FeishuProbeResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        probeAccount: async ({ account }) =>
          await (await loadFeishuChannelRuntime()).probeFeishu(account),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          name: account.name,
          extra: {
            appId: account.appId,
            domain: account.domain,
            port: runtime?.port ?? null,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorFeishuProvider } = await import("./monitor.js");
          const account = resolveFeishuRuntimeAccount(
            { cfg: ctx.cfg, accountId: ctx.accountId },
            { requireEventSecrets: true },
          );
          const port = account.config?.webhookPort ?? null;
          ctx.setStatus({ accountId: ctx.accountId, port });
          ctx.log?.info(
            `starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`,
          );
          return monitorFeishuProvider({
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            accountId: ctx.accountId,
          });
        },
      },
    },
    security: {
      collectWarnings: projectConfigAccountIdWarningCollector<{
        cfg: ClawdbotConfig;
        accountId?: string | null;
      }>(collectFeishuSecurityWarnings),
      collectAuditFindings: ({ cfg }) => collectFeishuSecurityAuditFindings({ cfg }),
    },
    pairing: {
      text: {
        idLabel: "feishuUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(feishu|user|open_id):/i),
        notify: async ({ cfg, id, message, accountId }) => {
          const { sendMessageFeishu } = await loadFeishuChannelRuntime();
          await sendMessageFeishu({
            cfg,
            to: id,
            text: message,
            accountId,
          });
        },
      },
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadFeishuChannelRuntime,
        sendText: { resolve: (runtime) => runtime.feishuOutbound.sendText },
        sendMedia: { resolve: (runtime) => runtime.feishuOutbound.sendMedia },
      }),
    },
  });
