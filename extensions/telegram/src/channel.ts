// Telegram plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildDmGroupAccountAllowlistAdapter,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { clearAccountFieldsFromConfigSection } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  createChannelMessageAdapterFromOutbound,
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  PAIRING_APPROVED_MESSAGE,
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { channelBlockedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveAgentRoute, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import { resolveTelegramAutoThreadId } from "./action-threading.js";
import { lookupTelegramChatId } from "./api-fetch.js";
import { telegramApprovalCapability } from "./approval-native.js";
import * as auditModule from "./audit.js";
import {
  deleteCachedTelegramBotInfo,
  readCachedTelegramBotInfo,
  writeCachedTelegramBotInfo,
} from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";
import { buildTelegramRoutingTarget, type TelegramThreadSpec } from "./bot/helpers.js";
import { telegramMessageActions } from "./channel-actions.js";
import {
  findTelegramTokenOwnerAccountId,
  formatDuplicateTelegramTokenReason,
  resolveTelegramConfigAccessorAccount,
  telegramConfigAdapter,
} from "./config-adapter.js";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.js";
import { resolveTelegramConversationBaseSessionKey } from "./conversation-route.js";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";
import { buildTelegramExecApprovalPendingPayload } from "./exec-approval-forwarding.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import * as monitorModule from "./monitor.js";
import {
  looksLikeTelegramTargetId,
  normalizeTelegramMessagingTarget,
  telegramMessagingTargetsMatch,
} from "./normalize.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { parseTelegramThreadId } from "./outbound-params.js";
import { releaseStoppedTelegramPollingLease } from "./polling-lease.js";
import type { TelegramProbe } from "./probe.js";
import * as probeModule from "./probe.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import { resolveTelegramStartupProbeTimeoutMs } from "./request-timeouts.js";
import { getOptionalTelegramRuntime, getTelegramRuntime } from "./runtime.js";
import { telegramSecurityAdapter } from "./security.js";
import { loadTelegramSendModule } from "./send-runtime.js";
import {
  resolveTelegramSessionConversation,
  resolveTelegramSessionTarget,
} from "./session-conversation.js";
import { telegramSetupContract } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import { createTelegramPluginBase } from "./shared.js";
import { withTelegramStartupProbeSlot } from "./startup-probe-limiter.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import { normalizeTelegramChatId, parseTelegramTarget } from "./targets.js";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";
import { resolveTelegramToken } from "./token.js";
import {
  parseTelegramTopicConversation,
  buildTelegramConversationId,
} from "./topic-conversation.js";

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;

const loadTelegramUpdateOffsetRuntime = createLazyRuntimeModule(
  () => import("../update-offset-runtime-api.js"),
);

function resolveTelegramProbe() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.probeTelegram ?? probeModule.probeTelegram
  );
}

function isTelegramRichMessagesEnabled(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const selectedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return mergeTelegramAccountConfig(cfg, selectedAccountId).richMessages === true;
}

async function readStartupBotInfoCache(params: {
  accountId: string;
  token: string;
  log?: { debug?: (message: string) => void };
}): Promise<TelegramBotInfo | undefined> {
  try {
    const cached = await readCachedTelegramBotInfo({
      accountId: params.accountId,
      botToken: params.token,
    });
    return cached?.botInfo;
  } catch (err) {
    if (getTelegramRuntime().logging.shouldLogVerbose()) {
      params.log?.debug?.(`[${params.accountId}] bot info cache read failed: ${String(err)}`);
    }
    return undefined;
  }
}

async function writeStartupBotInfoCache(params: {
  accountId: string;
  token: string;
  botInfo: TelegramBotInfo;
  log?: { debug?: (message: string) => void };
}): Promise<void> {
  try {
    await writeCachedTelegramBotInfo({
      accountId: params.accountId,
      botToken: params.token,
      botInfo: params.botInfo,
    });
  } catch (err) {
    if (getTelegramRuntime().logging.shouldLogVerbose()) {
      params.log?.debug?.(`[${params.accountId}] bot info cache write failed: ${String(err)}`);
    }
  }
}

async function deleteStartupBotInfoCache(accountId: string): Promise<void> {
  await deleteCachedTelegramBotInfo({ accountId }).catch(() => undefined);
}

function resolveTelegramAuditCollector() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.collectTelegramUnmentionedGroupIds ??
    auditModule.collectTelegramUnmentionedGroupIds
  );
}

function resolveTelegramAuditMembership() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.auditTelegramGroupMembership ??
    auditModule.auditTelegramGroupMembership
  );
}

function resolveTelegramMonitor() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.monitorTelegramProvider ??
    monitorModule.monitorTelegramProvider
  );
}

function formatTelegramUnauthorizedTokenError(
  account: ResolvedTelegramAccount,
  status: 401 | 404,
): string {
  const source =
    account.tokenSource === "none" ? "no configured token" : `${account.tokenSource} token`;
  const credentialPath =
    account.accountId === DEFAULT_ACCOUNT_ID
      ? "channels.telegram.botToken, channels.telegram.tokenFile, or TELEGRAM_BOT_TOKEN"
      : `channels.telegram.accounts.${account.accountId}.botToken/tokenFile`;
  return `Telegram bot token unauthorized for account "${account.accountId}" (getMe returned ${status} from Telegram; source: ${source}). Update ${credentialPath} with the current BotFather token.`;
}

async function resolveTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    getOptionalTelegramRuntime()?.channel?.telegram?.sendMessageTelegram ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function resolveTelegramTokenHelper() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.resolveTelegramToken ?? resolveTelegramToken
  );
}

const telegramChannelOutbound = createTelegramOutboundAdapter({
  resolveSend: resolveTelegramSend,
  loadSendModule: loadTelegramSendModule,
  shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
    shouldSuppressLocalTelegramExecApprovalPrompt({
      cfg,
      accountId,
      payload,
    }),
  beforeDeliverPayload: async ({ cfg, target, hint }) => {
    if (hint?.kind !== "approval-pending" || hint.approvalKind !== "exec") {
      return;
    }
    const threadId =
      typeof target.threadId === "number"
        ? target.threadId
        : typeof target.threadId === "string"
          ? parseTelegramThreadId(target.threadId)
          : undefined;
    const { sendTypingTelegram } = await loadTelegramSendModule();
    await sendTypingTelegram(target.to, {
      cfg,
      accountId: target.accountId ?? undefined,
      ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
    }).catch(() => {});
  },
  shouldTreatDeliveredTextAsVisible: shouldTreatTelegramDeliveredTextAsVisible,
  targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
  preferFinalAssistantVisibleText: true,
});

const telegramMessageAdapter = createChannelMessageAdapterFromOutbound<OpenClawConfig>({
  id: "telegram",
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        previewReceipt: true,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  receive: {
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
  },
  outbound: telegramChannelOutbound,
});

function normalizeTelegramAcpConversationId(conversationId: string) {
  const parsed = parseTelegramTopicConversation({ conversationId });
  if (!parsed || !parsed.chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: parsed.chatId,
  };
}

function matchTelegramAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeTelegramAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!incoming || !incoming.chatId.startsWith("-")) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    parentConversationId: incoming.chatId,
    matchPriority: 2,
  };
}

function shouldTreatTelegramDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  void params.text;
  return params.kind !== "final";
}

function targetsMatchTelegramReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const origin = parseTelegramTarget(params.originTarget);
  const target = parseTelegramTarget(params.targetKey);
  const originConversation = buildTelegramConversationId({
    chatId: origin.chatId,
    thread: resolveTelegramTargetThread(origin) ?? { scope: "none" },
  });
  const targetConversation = buildTelegramConversationId({
    chatId: target.chatId,
    thread: resolveTelegramTargetThread(target, normalizeOptionalString(params.targetThreadId)) ?? {
      scope: "none",
    },
  });
  return (
    normalizeOptionalLowercaseString(originConversation) ===
    normalizeOptionalLowercaseString(targetConversation)
  );
}

function resolveTelegramTargetThread(
  target: ReturnType<typeof parseTelegramTarget>,
  fallbackThreadId?: string | number | null,
): TelegramThreadSpec | undefined {
  if (target.directMessagesTopicId != null) {
    return { id: target.directMessagesTopicId, scope: "direct-messages" };
  }
  const forumThreadId = target.messageThreadId ?? fallbackThreadId;
  if (forumThreadId == null) {
    return undefined;
  }
  const id = Number(forumThreadId);
  return Number.isFinite(id) ? { id, scope: "forum" } : undefined;
}

function resolveTelegramCommandConversation(params: {
  threadId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  for (const candidate of [params.originatingTo, params.commandTo, params.fallbackTo]) {
    if (!candidate) {
      continue;
    }
    const parsedTarget = parseTelegramTarget(candidate);
    const chatId = normalizeTelegramChatId(parsedTarget.chatId);
    if (!chatId) {
      continue;
    }
    const thread = resolveTelegramTargetThread(parsedTarget, params.threadId);
    const conversationId = buildTelegramConversationId({
      chatId,
      thread: thread ?? { scope: "none" },
    });
    if (conversationId !== chatId || !chatId.startsWith("-")) {
      return { conversationId, parentConversationId: chatId };
    }
  }
  return null;
}

function resolveTelegramInboundConversation(params: {
  to?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
}) {
  const parsedConversation =
    params.conversationId &&
    parseTelegramTopicConversation({
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    });
  if (parsedConversation) {
    return {
      conversationId: parsedConversation.canonicalConversationId,
      parentConversationId: parsedConversation.chatId,
    };
  }
  const rawTarget = params.to || params.parentConversationId || params.conversationId || "";
  if (!rawTarget) {
    return null;
  }
  const parsedTarget = parseTelegramTarget(rawTarget);
  const chatId = normalizeOptionalString(parsedTarget.chatId) ?? "";
  if (!chatId) {
    return null;
  }
  return {
    conversationId: buildTelegramConversationId({
      chatId,
      thread: resolveTelegramTargetThread(parsedTarget, params.threadId) ?? { scope: "none" },
    }),
    parentConversationId: chatId,
  };
}

function resolveTelegramDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}) {
  const parsedTopic = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (parsedTopic) {
    return {
      to: parsedTopic.canonicalConversationId,
      threadId: parsedTopic.thread.id == null ? undefined : String(parsedTopic.thread.id),
    };
  }
  const parsedTarget = parseTelegramTarget(
    params.conversationId.trim() || params.parentConversationId?.trim() || "",
  );
  if (!parsedTarget.chatId.trim()) {
    return null;
  }
  return {
    to: parsedTarget.chatId,
    ...(parsedTarget.messageThreadId != null
      ? { threadId: String(parsedTarget.messageThreadId) }
      : {}),
  };
}

function resolveTelegramRouteTarget(raw: string) {
  const target = parseTelegramTarget(raw);
  return {
    to: target.chatId,
    threadId: target.messageThreadId,
    chatType: target.chatType === "unknown" ? undefined : target.chatType,
  };
}

function shouldStripTelegramThreadFromAnnounceOrigin(params: {
  requester: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
  entry: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
}): boolean {
  const requesterChannel = normalizeOptionalLowercaseString(params.requester.channel);
  if (requesterChannel && requesterChannel !== "telegram") {
    return true;
  }
  const requesterTo = params.requester.to?.trim();
  if (!requesterTo) {
    return false;
  }
  if (!requesterChannel && !requesterTo.startsWith("telegram:")) {
    return true;
  }
  const requesterTarget = resolveTelegramRouteTarget(requesterTo);
  if (requesterTarget.chatType !== "group") {
    return true;
  }
  const entryTo = params.entry.to?.trim();
  if (!entryTo) {
    return false;
  }
  const entryTarget = resolveTelegramRouteTarget(entryTo);
  return entryTarget.to !== requesterTarget.to;
}

function resolveTelegramOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  replyToId?: string | null;
  threadId?: string | number | null;
  currentSessionKey?: string | null;
}) {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const thread = resolveTelegramTargetThread(parsed, parseTelegramThreadId(params.threadId));
  const resolvedThreadId = thread ? Number(thread.id) : undefined;
  const conversationId = buildTelegramConversationId({
    chatId,
    thread: thread ?? { scope: "none" },
  });
  const resolvedKind = params.resolvedTarget?.kind;
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" && resolvedKind !== undefined && resolvedKind !== "user");
  // Telegram private chat ids are the sender's stable numeric user id, while
  // group ids are negative. Usernames remain aliases and cannot key replies.
  const recipientSessionExact = /^-?\d+$/.test(chatId);
  const peerId = isGroup && resolvedThreadId ? conversationId : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId,
    recipientSessionExact,
    peer,
    chatType: isGroup ? ("group" as const) : ("direct" as const),
    from: isGroup
      ? `telegram:group:${peerId}`
      : resolvedThreadId
        ? `telegram:${conversationId}`
        : `telegram:${chatId}`,
    to: `telegram:${conversationId}`,
    ...(isGroup && resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
  });
  if (isGroup) {
    return baseRoute;
  }
  const inboundBaseSessionKey = resolveTelegramConversationBaseSessionKey({
    cfg: params.cfg,
    route: {
      agentId: params.agentId,
      accountId,
      matchedBy: "default",
      sessionKey: baseRoute.sessionKey,
    },
    chatId,
    isGroup: false,
    senderId: chatId,
  });
  const directBaseRoute = {
    ...baseRoute,
    sessionKey: inboundBaseSessionKey,
    baseSessionKey: inboundBaseSessionKey,
  };
  const canonicalThreadId =
    resolvedThreadId !== undefined
      ? buildTelegramCanonicalTopicThreadId({
          chatId,
          topicId: resolvedThreadId,
          scope: thread?.scope ?? "forum",
        })
      : undefined;
  const route = buildThreadAwareOutboundSessionRoute({
    route: directBaseRoute,
    threadId: canonicalThreadId,
    currentSessionKey: params.currentSessionKey,
    precedence: ["threadId", "currentSession"],
    canRecoverCurrentThread: ({ route: routeLocal }) =>
      routeLocal.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
  const routeThreadId = resolveTelegramNativeTopicThreadId(route.threadId, resolvedThreadId);
  return {
    ...route,
    ...(routeThreadId !== undefined ? { threadId: routeThreadId } : {}),
    from:
      routeThreadId !== undefined
        ? buildTelegramRoutingTarget(chatId, {
            id: Number(routeThreadId),
            scope: thread?.scope ?? "forum",
          })
        : `telegram:${chatId}`,
  };
}

function buildTelegramCanonicalTopicThreadId(params: {
  chatId: string;
  topicId: number;
  scope: TelegramThreadSpec["scope"];
}): string {
  // Core session routing sees one canonical thread id. Telegram topic ids are
  // chat-scoped, so direct-topic sessions include the chat id to avoid collisions.
  return params.scope === "direct-messages"
    ? buildTelegramConversationId({
        chatId: params.chatId,
        thread: { id: params.topicId, scope: params.scope },
      })
    : `${params.chatId}:${params.topicId}`;
}

function resolveTelegramNativeTopicThreadId(
  threadId?: string | number,
  nativeTopicId?: number,
): string | number | undefined {
  if (nativeTopicId !== undefined) {
    return nativeTopicId;
  }
  // Keep the chat-scoped canonical id inside OpenClaw state; translate it back
  // only when returning Telegram route metadata used by send/typing paths.
  if (threadId === undefined) {
    return undefined;
  }
  const parsedThreadId = parseTelegramThreadId(threadId);
  if (parsedThreadId !== undefined) {
    return parsedThreadId;
  }
  if (typeof threadId === "string") {
    const canonicalMatch = /:(\d+)$/.exec(threadId.trim());
    if (canonicalMatch?.[1]) {
      return Number(canonicalMatch[1]);
    }
  }
  return threadId;
}

async function resolveTelegramTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
}) {
  if (params.kind !== "user") {
    return params.inputs.map((input) => ({
      input,
      resolved: false as const,
      note: "Telegram runtime target resolution only supports usernames for direct-message lookups.",
    }));
  }
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const token = account.token.trim();
  if (!token) {
    return params.inputs.map((input) => ({
      input,
      resolved: false as const,
      note: "Telegram bot token is required to resolve @username targets.",
    }));
  }
  return await Promise.all(
    params.inputs.map(async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return {
          input,
          resolved: false as const,
          note: "Telegram target is required.",
        };
      }
      const normalized = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      try {
        const id = await lookupTelegramChatId({
          token,
          chatId: normalized,
          // Runtime requests honor configured routing. Doctor intentionally omits these
          // fields so repair does not send the bot token to config-controlled endpoints.
          proxyUrl: account.config.proxy,
          apiRoot: account.config.apiRoot,
          network: account.config.network,
        });
        if (!id) {
          return {
            input,
            resolved: false as const,
            note: "Telegram username could not be resolved by the configured bot.",
          };
        }
        return {
          input,
          resolved: true as const,
          id,
          name: normalized,
        };
      } catch (error) {
        return {
          input,
          resolved: false as const,
          note: formatErrorMessage(error),
        };
      }
    }),
  );
}

const resolveTelegramAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  resolveRecord: (account: ResolvedTelegramAccount) => account.config.groups,
  outerLabel: (groupId) => groupId,
  resolveOuterEntries: (groupCfg) => groupCfg?.allowFrom,
  resolveChildren: (groupCfg) => groupCfg?.topics,
  innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
  resolveInnerEntries: (topicCfg) => topicCfg?.allowFrom,
});

export const telegramPlugin = createChatChannelPlugin({
  base: {
    ...createTelegramPluginBase({
      setupWizard: telegramSetupWizard,
      setupContract: telegramSetupContract,
    }),
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: "telegram",
      resolveAccount: resolveTelegramAccount,
      normalize: ({ cfg, accountId, values }) =>
        telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveDmAllowFrom: (account) => account.config.allowFrom,
      resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
      resolveDmPolicy: (account) => account.config.dmPolicy,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
      resolveGroupOverrides: resolveTelegramAllowlistGroupOverrides,
    }),
    bindings: {
      selfParentConversationByDefault: true,
      compileConfiguredBinding: ({ conversationId }) =>
        normalizeTelegramAcpConversationId(conversationId),
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
        matchTelegramAcpConversation({
          bindingConversationId: compiledBinding.conversationId,
          conversationId,
          parentConversationId,
        }),
      resolveCommandConversation: ({ threadId, originatingTo, commandTo, fallbackTo }) =>
        resolveTelegramCommandConversation({
          threadId,
          originatingTo,
          commandTo,
          fallbackTo,
        }),
    },
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      bindingStore: "adapter",
      defaultTopLevelPlacement: "current",
      resolveConversationRef: ({
        accountId: _accountId,
        conversationId,
        parentConversationId,
        threadId,
      }) =>
        resolveTelegramInboundConversation({
          to: conversationId,
          conversationId,
          parentConversationId,
          threadId: threadId ?? undefined,
        }),
      buildBoundReplyPayload: ({ operation, conversation }) => {
        if (operation !== "acp-spawn") {
          return null;
        }
        return conversation.conversationId.includes(":topic:")
          ? { delivery: { pin: { enabled: true, notify: false } } }
          : null;
      },
      shouldStripThreadFromAnnounceOrigin: shouldStripTelegramThreadFromAnnounceOrigin,
      createManager: ({ cfg, accountId }) =>
        createTelegramThreadBindingManager({
          cfg,
          accountId: accountId ?? undefined,
          persist: false,
          enableSweeper: false,
        }),
      setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
        setTelegramThreadBindingIdleTimeoutBySessionKey({
          targetSessionKey,
          accountId: accountId ?? undefined,
          idleTimeoutMs,
        }),
      setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
        setTelegramThreadBindingMaxAgeBySessionKey({
          targetSessionKey,
          accountId: accountId ?? undefined,
          maxAgeMs,
        }),
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    agentPrompt: {
      messageToolCapabilities: ({ cfg, accountId }) => {
        const inlineButtonsScope = resolveTelegramInlineButtonsScope({
          cfg,
          accountId: accountId ?? undefined,
        });
        return [
          ...(inlineButtonsScope === "off" ? [] : ["inlineButtons"]),
          ...(isTelegramRichMessagesEnabled(cfg, accountId) ? ["markdownDetails"] : []),
        ];
      },
      // Authoring contract lives here so every runtime (including native Codex)
      // sees it via inbound-meta response_format; core system-prompt no longer owns it.
      inboundFormattingHints: ({ cfg, accountId }) => {
        const richMessages = isTelegramRichMessagesEnabled(cfg, accountId);
        if (richMessages) {
          return {
            text_markup: "markdown_telegram_rich",
            rules: [
              "Telegram rich ON (Bot API 10.2 blocks; OpenClaw maps markdown + these HTML islands to typed blocks).",
              'Supported: headings, tables (markdown, or `<table>` HTML for caption/colspan/rowspan/align), block/pull quotes (`<aside>` + `<cite>`), `<details><summary>` (+`open`), dividers `<hr/>`, sup/sub/mark/spoilers, `<ul>`/`<ol>` + `<input type="checkbox" checked/>` tasks, code, anchors `<a name="x"></a>` + `<a href="#x">label</a>`, custom emoji `<tg-emoji emoji-id="...">`, maps `<tg-map lat="" long="" zoom=""/>`, collages/slideshows `<tg-collage>`/`<tg-slideshow>`, block media e.g. `<img src="https://..."/>` (+`<figure>`/`<figcaption>`).',
              "Math: `<tg-math>` inline, `<tg-math-block>` block; never `$...$`/`\\(...\\)`.",
              "Not MarkdownV2/parse_mode.",
              "Collapse=`<details>` (not expandable blockquote); structured bullets=`<ul><li>` (not literal bullets).",
              "Media https URLs only, block-level only, captions/credits when useful; buttons plain text; normal files via attachments.",
            ],
          };
        }
        return {
          text_markup: "markdown",
          rules: [
            "Telegram rich OFF. Standard Telegram formatting only; no rich tables/details/block media/formulas.",
            "Owner can enable `richMessages` for this Telegram account.",
          ],
        };
      },
      reactionGuidance: ({ cfg, accountId }) => {
        const level = resolveTelegramReactionLevel({
          cfg,
          accountId: accountId ?? undefined,
        }).agentReactionGuidance;
        return level ? { level, channelLabel: "Telegram" } : undefined;
      },
    },
    messaging: {
      defaultMarkdownTableMode: "block",
      targetPrefixes: ["telegram", "tg"],
      resolveConversationRouteOwner: inspectTelegramConversationRouteOwner,
      numericTopicShorthand: true,
      normalizeTarget: normalizeTelegramMessagingTarget,
      resolveInboundConversation: ({ to, conversationId, threadId }) =>
        resolveTelegramInboundConversation({ to, conversationId, threadId }),
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) =>
        resolveTelegramDeliveryTarget({ conversationId, parentConversationId }),
      // Same function as the public session-key artifact so the pre-registry
      // fast path cannot drift from plugin behavior (pinned by contract test).
      resolveSessionConversation: resolveTelegramSessionConversation,
      resolveSessionTarget: ({ kind, id, threadId }) =>
        resolveTelegramSessionTarget({ kind, id, threadId }),
      inferTargetChatType: ({ to }) => resolveTelegramRouteTarget(to).chatType,
      preserveHeartbeatThreadIdForGroupRoute: true,
      formatTargetDisplay: ({ target, display, kind }) => {
        const formatted = display?.trim();
        if (formatted) {
          return formatted;
        }
        const trimmedTarget = target.trim();
        if (!trimmedTarget) {
          return trimmedTarget;
        }
        const withoutProvider = trimmedTarget.replace(/^(telegram|tg):/i, "");
        if (kind === "user" || /^user:/i.test(withoutProvider)) {
          return `@${withoutProvider.replace(/^user:/i, "")}`;
        }
        if (/^channel:/i.test(withoutProvider)) {
          return `#${withoutProvider.replace(/^channel:/i, "")}`;
        }
        return withoutProvider;
      },
      resolveOutboundSessionRoute: (params) => resolveTelegramOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeTelegramTargetId,
        hint: "<chatId>",
        reservedLiterals: ["current", "self", "this", "me"],
      },
    },
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) =>
        await resolveTelegramTargets({ cfg, accountId, inputs, kind }),
    },
    lifecycle: {
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        const previousToken = resolveTelegramAccount({ cfg: prevCfg, accountId }).token.trim();
        const nextToken = resolveTelegramAccount({ cfg: nextCfg, accountId }).token.trim();
        if (previousToken !== nextToken) {
          const { deleteTelegramUpdateOffset } = await loadTelegramUpdateOffsetRuntime();
          await Promise.all([
            deleteTelegramUpdateOffset({ accountId }),
            deleteStartupBotInfoCache(accountId),
          ]);
        }
      },
      onAccountRemoved: async ({ accountId }) => {
        const { deleteTelegramUpdateOffset } = await loadTelegramUpdateOffsetRuntime();
        await Promise.all([
          deleteTelegramUpdateOffset({ accountId }),
          deleteStartupBotInfoCache(accountId),
        ]);
      },
    },
    heartbeat: {
      sendTyping: async ({ cfg, to, accountId, threadId }) => {
        const { sendTypingTelegram } = await loadTelegramSendModule();
        await sendTypingTelegram(to, {
          cfg,
          ...(accountId ? { accountId } : {}),
          messageThreadId: parseTelegramThreadId(threadId),
        });
      },
    },
    approvalCapability: {
      ...telegramApprovalCapability,
      render: {
        exec: {
          buildPendingPayload: ({ request, nowMs }) =>
            buildTelegramExecApprovalPendingPayload({ request, nowMs }),
        },
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
      listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
    }),
    actions: telegramMessageActions,
    message: telegramMessageAdapter,
    status: createComputedAccountStatusAdapter<ResolvedTelegramAccount, TelegramProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: collectTelegramStatusIssues,
      buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        resolveTelegramProbe()(account.token, timeoutMs, {
          accountId: account.accountId,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
          includeWebhookInfo: Boolean(account.config.webhookUrl),
        }),
      formatCapabilitiesProbe: ({ probe }) => {
        const lines = [];
        if (probe?.bot?.username) {
          const botId = probe.bot.id ? ` (${probe.bot.id})` : "";
          lines.push({ text: `Bot: @${probe.bot.username}${botId}` });
        }
        const flags: string[] = [];
        if (typeof probe?.bot?.canJoinGroups === "boolean") {
          flags.push(`joinGroups=${probe.bot.canJoinGroups}`);
        }
        if (typeof probe?.bot?.canReadAllGroupMessages === "boolean") {
          flags.push(`readAllGroupMessages=${probe.bot.canReadAllGroupMessages}`);
        }
        if (typeof probe?.bot?.supportsInlineQueries === "boolean") {
          flags.push(`inlineQueries=${probe.bot.supportsInlineQueries}`);
        }
        if (flags.length > 0) {
          lines.push({ text: `Flags: ${flags.join(" ")}` });
        }
        if (probe?.webhook?.url !== undefined) {
          lines.push({ text: `Webhook: ${probe.webhook.url || "none"}` });
        }
        return lines;
      },
      auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
        const groups =
          cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
          cfg.channels?.telegram?.groups;
        const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
          resolveTelegramAuditCollector()(groups);
        if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
          return undefined;
        }
        const botId = probe?.ok && probe.bot?.id != null ? probe.bot.id : null;
        if (!botId) {
          return {
            ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
            checkedGroups: 0,
            unresolvedGroups,
            hasWildcardUnmentionedGroups,
            groups: [],
            elapsedMs: 0,
          };
        }
        const audit = await resolveTelegramAuditMembership()({
          token: account.token,
          botId,
          groupIds,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
          timeoutMs,
        });
        return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
      },
      resolveAccountSnapshot: ({ account, cfg, runtime, audit }) => {
        const configuredFromStatus = resolveConfiguredFromCredentialStatuses(account);
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          cfg,
          accountId: account.accountId,
        });
        const duplicateTokenReason = ownerAccountId
          ? formatDuplicateTelegramTokenReason({
              accountId: account.accountId,
              ownerAccountId,
            })
          : null;
        const configured =
          (configuredFromStatus ?? Boolean(account.token?.trim())) && !ownerAccountId;
        const groups =
          cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
          cfg.channels?.telegram?.groups;
        const allowUnmentionedGroups =
          groups?.["*"]?.requireMention === false ||
          Object.entries(groups ?? {}).some(
            ([key, value]) => key !== "*" && value?.requireMention === false,
          );
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          extra: {
            ...projectCredentialSnapshotFields(account),
            lastError: runtime?.lastError ?? duplicateTokenReason,
            mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
            audit,
            allowUnmentionedGroups,
          },
        };
      },
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const ownerAgentId = resolveAgentRoute({
          cfg: ctx.cfg,
          channel: "telegram",
          accountId: account.accountId,
        }).agentId;
        const setStatus = createAccountStatusSink({
          accountId: account.accountId,
          setStatus: ctx.setStatus,
        });
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          cfg: ctx.cfg,
          accountId: account.accountId,
        });
        if (ownerAccountId) {
          const reason = formatDuplicateTelegramTokenReason({
            accountId: account.accountId,
            ownerAccountId,
          });
          ctx.log?.error?.(`[${account.accountId}] ${reason}`);
          throw new Error(reason);
        }
        const token = (account.token ?? "").trim();
        let telegramBotLabel = "";
        let unauthorizedTokenReason: string | null = null;
        let botInfo: TelegramBotInfo | undefined;
        try {
          const probe = await withTelegramStartupProbeSlot(ctx.abortSignal, () =>
            resolveTelegramProbe()(token, resolveTelegramStartupProbeTimeoutMs(undefined), {
              accountId: account.accountId,
              proxyUrl: account.config.proxy,
              network: account.config.network,
              apiRoot: account.config.apiRoot,
              includeWebhookInfo: false,
              abortSignal: ctx.abortSignal,
            }),
          );
          const username = probe.ok ? probe.bot?.username?.trim() : null;
          if (username) {
            telegramBotLabel = ` (@${username})`;
          }
          botInfo = probe.ok ? probe.botInfo : undefined;
          if (probe.ok && probe.botInfo) {
            await writeStartupBotInfoCache({
              accountId: account.accountId,
              token,
              botInfo: probe.botInfo,
              log: ctx.log,
            });
          }
          if (!probe.ok && (probe.status === 401 || probe.status === 404)) {
            await deleteStartupBotInfoCache(account.accountId);
            unauthorizedTokenReason = formatTelegramUnauthorizedTokenError(account, probe.status);
          } else if (!probe.ok) {
            botInfo = await readStartupBotInfoCache({
              accountId: account.accountId,
              token,
              log: ctx.log,
            });
            if (botInfo) {
              telegramBotLabel = ` (@${botInfo.username})`;
            }
          }
        } catch (err) {
          if (ctx.abortSignal.aborted) {
            return;
          }
          if (getTelegramRuntime().logging.shouldLogVerbose()) {
            ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
          }
          botInfo = await readStartupBotInfoCache({
            accountId: account.accountId,
            token,
            log: ctx.log,
          });
          if (botInfo) {
            telegramBotLabel = ` (@${botInfo.username})`;
          }
        }
        if (unauthorizedTokenReason) {
          ctx.log?.error?.(`[${account.accountId}] ${unauthorizedTokenReason}`);
          setStatus(channelBlockedPatch(unauthorizedTokenReason));
          throw new Error(unauthorizedTokenReason);
        }
        ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);
        return resolveTelegramMonitor()({
          token,
          accountId: account.accountId,
          ownerAgentId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          channelRuntime: ctx.channelRuntime,
          abortSignal: ctx.abortSignal,
          useWebhook: Boolean(account.config.webhookUrl),
          webhookUrl: account.config.webhookUrl,
          webhookSecret: account.config.webhookSecret,
          webhookPath: account.config.webhookPath,
          webhookHost: account.config.webhookHost,
          webhookPort: account.config.webhookPort,
          webhookCertPath: account.config.webhookCertPath,
          botInfo,
          setStatus,
        });
      },
      stopAccount: async ({ account, accountId, log }) => {
        const token = (account.token ?? "").trim();
        if (!token) {
          return;
        }
        const released = await releaseStoppedTelegramPollingLease({
          token,
          accountId,
        });
        if (released) {
          log?.info?.(`[${accountId}] released stopped Telegram polling lease`);
        }
      },
      logoutAccount: async ({ accountId, cfg }) => {
        const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
        const { nextConfig, changed, cleared } = clearAccountFieldsFromConfigSection({
          cfg,
          sectionKey: "telegram",
          accountId,
          fields: ["botToken"],
        });
        const resolved = resolveTelegramAccount({
          cfg: nextConfig,
          accountId,
        });
        const loggedOut = resolved.tokenSource === "none";
        if (changed) {
          await getTelegramRuntime().config.replaceConfigFile({
            nextConfig,
            afterWrite: { mode: "auto" },
          });
        }
        if (cleared || loggedOut) {
          await deleteStartupBotInfoCache(accountId);
        }
        return { cleared, envToken: Boolean(envToken), loggedOut };
      },
    },
  },
  pairing: {
    text: {
      idLabel: "telegramUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: createPairingPrefixStripper(/^(telegram|tg):/i),
      notify: async ({ cfg, id, message, accountId }) => {
        const { token } = resolveTelegramTokenHelper()(cfg, { accountId });
        if (!token) {
          throw new Error("telegram token not configured");
        }
        const send = await resolveTelegramSend();
        await send(id, message, { cfg, token, accountId });
      },
    },
  },
  security: telegramSecurityAdapter,
  threading: {
    matchesToolContextTarget: ({ target, toolContext }) => {
      return [toolContext.currentMessagingTarget, toolContext.currentChannelId].some(
        (currentTarget) =>
          currentTarget != null && telegramMessagingTargetsMatch(target, currentTarget),
      );
    },
    resolveReplyToMode: ({ cfg, accountId }) =>
      resolveTelegramConfigAccessorAccount({ cfg, accountId }).config.replyToMode ?? "off",
    buildToolContext: (params) => buildTelegramThreadingToolContext(params),
    resolveAutoThreadId: ({ to, toolContext }) => resolveTelegramAutoThreadId({ to, toolContext }),
    resolveCurrentChannelId: ({ to, threadId }) => {
      if (threadId == null) {
        return to;
      }
      const parsed = parseTelegramTarget(to);
      return parsed.messageThreadId != null || parsed.directMessagesTopicId != null
        ? to
        : `${to}:topic:${threadId}`;
    },
  },
  outbound: telegramChannelOutbound,
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
