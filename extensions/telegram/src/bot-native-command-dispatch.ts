// Telegram plugin module implements native command admission and dispatch behavior.
import type { Bot, Context } from "grammy";
import {
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import type {
  ChannelGroupPolicy,
  OpenClawConfig,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { danger, logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeDmAllowFromWithStore, resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramResolvedGroupConfig } from "./bot-handlers.types.js";
import { resolveTelegramMessageTurnSettings } from "./bot-message.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  extractTelegramForumFlag,
  isTelegramCommandsAllowFromConfigured,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramCommandAuthorization,
  resolveTelegramForumFlag,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMessageThreadSpec,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import {
  buildTelegramConversationRouteContext,
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import {
  resolveTelegramDirectToolPolicy,
  resolveTelegramGroupPromptSettings,
} from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import { getTopicName, resolveTopicNameCacheScope } from "./topic-name-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const NON_PLUGIN_COMMAND_DISPATCH = Object.freeze({
  kind: "non-plugin",
}) satisfies PluginCommandCatalogDecision;

const loadTelegramNativeCommandDeliveryRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.delivery.runtime.js"),
);
const loadTelegramNativeCommandRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.runtime.js"),
);

type TelegramNativeCommandRuntime = Awaited<ReturnType<typeof loadTelegramNativeCommandRuntime>>;
type TelegramNativeCommandDeliveryRuntime = Awaited<
  ReturnType<typeof loadTelegramNativeCommandDeliveryRuntime>
>;
type DeliveryBaseOptions = Omit<
  Parameters<TelegramNativeCommandDeliveryRuntime["deliverReplies"]>[0],
  "replies" | "silent"
>;

export type TelegramCommandExecutorParams = {
  botUser: Context["me"];
  msg: NonNullable<Context["message"]>;
  rawText: string;
  bot: Bot;
  runtime: RuntimeEnv;
  accountId: string;
  mediaMaxBytes?: number;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: Pick<
    TelegramBotOptions,
    | "token"
    | "ownerAgentId"
    | "botInfo"
    | "allowFrom"
    | "groupAllowFrom"
    | "replyToMode"
    | "accountAbortSignal"
  >;
};

type TelegramCommandAuthResult = NonNullable<
  Awaited<ReturnType<typeof resolveTelegramCommandAuth>>
>;

export type TelegramCommandDispatch = TelegramCommandExecutorParams &
  TelegramCommandAuthResult & {
    telegramDeps: TelegramNativeCommandDeps;
    runtimeCfg: OpenClawConfig;
    runtimeTelegramCfg: TelegramAccountConfig;
    turnSettings: ReturnType<typeof resolveTelegramMessageTurnSettings>;
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    threadParams: ReturnType<typeof buildTelegramThreadParams>;
    route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
    mediaLocalRoots: readonly string[] | undefined;
    targetSessionKey: string;
    nativeCommandRuntime: TelegramNativeCommandRuntime;
    buildDeliveryBaseOptions: (params?: {
      sessionKeyForInternalHooks?: string;
      policySessionKey?: string;
    }) => DeliveryBaseOptions;
    loadDeliveryRuntime: () => Promise<TelegramNativeCommandDeliveryRuntime>;
  };

async function resolveTelegramNativeCommandThreadContext(params: {
  msg: NonNullable<Context["message"]>;
  bot: Bot;
}) {
  const { msg, bot } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const getChat =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum =
    msg.chat.is_direct_messages === true
      ? false
      : await resolveTelegramForumFlag({
          chatId,
          chatType: msg.chat.type,
          isGroup,
          isForum: extractTelegramForumFlag(msg.chat),
          isTopicMessage: msg.is_topic_message,
          getChat,
        });
  const threadSpec = resolveTelegramMessageThreadSpec(msg, isForum);
  return {
    chatId,
    isGroup,
    isForum,
    threadSpec,
    threadParams: buildTelegramThreadParams(threadSpec),
  };
}

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<Context["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  readChannelAllowFromStore: TelegramBotDeps["readChannelAllowFromStore"];
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  resolveGroupPolicy: TelegramCommandExecutorParams["resolveGroupPolicy"];
  resolveTelegramGroupConfig: TelegramCommandExecutorParams["resolveTelegramGroupConfig"];
  requireAuth: boolean;
}) {
  const { msg, bot, cfg, accountId, telegramCfg, requireAuth } = params;
  const { chatId, isGroup, isForum, threadSpec, threadParams } =
    await resolveTelegramNativeCommandThreadContext({ msg, bot });
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  const commandsAllowFromConfigured = isTelegramCommandsAllowFromConfigured(cfg);
  const preContextCommandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveTelegramCommandAuthorization({
        cfg,
        accountId,
        chatId,
        isGroup,
        threadSpec,
        senderId,
        senderUsername,
      })
    : null;
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    cfg,
    chatId,
    accountId,
    dmPolicy: telegramCfg.dmPolicy,
    allowFrom: params.allowFrom,
    senderId,
    isGroup,
    threadSpec,
    groupAllowFrom: params.groupAllowFrom,
    skipPairingStoreRead: Boolean(preContextCommandsAllowFromAccess?.isAuthorizedSender),
    readChannelAllowFromStore: params.readChannelAllowFromStore,
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig,
  });
  const {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  } = groupAllowContext;
  const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup,
    groupConfig,
    dmPolicy: telegramCfg.dmPolicy,
  });
  const requireTopic =
    !isGroup && groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
  if (!isGroup && requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }
  const commandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveTelegramCommandAuthorization({
        cfg,
        accountId,
        chatId,
        isGroup,
        threadSpec,
        senderId,
        senderUsername,
      })
    : null;
  const ownerAccess = resolveTelegramCommandAuthorization({
    cfg,
    accountId,
    chatId,
    isGroup,
    threadSpec,
    senderId,
    senderUsername,
  });
  const sendAuthMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, text, threadParams ?? {}),
    });
    return null;
  };
  const rejectNotAuthorized = async () =>
    await sendAuthMessage("You are not authorized to use this command.");

  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: requireAuth,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram command in group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram command in topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    return await rejectNotAuthorized();
  }

  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    resolveGroupPolicy: params.resolveGroupPolicy,
    enforcePolicy: true,
    enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: true,
  });
  if (!policyAccess.allowed) {
    if (policyAccess.reason === "group-policy-disabled") {
      logVerbose("Blocked telegram command (groupPolicy: disabled)");
      return null;
    }
    if (
      policyAccess.reason === "group-policy-allowlist-no-sender" ||
      policyAccess.reason === "group-policy-allowlist-unauthorized"
    ) {
      return await rejectNotAuthorized();
    }
    if (policyAccess.reason === "group-chat-not-allowed") {
      logVerbose(`Blocked telegram command in group ${chatId} (group not allowed)`);
      return null;
    }
  }

  const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: groupAllowOverride ?? params.allowFrom,
    accountId,
    senderId,
  });
  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: expandedDmAllowFrom,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const commandAuthorized = commandsAllowFromConfigured
    ? Boolean(commandsAllowFromAccess?.isAuthorizedSender)
    : (
        await resolveTelegramCommandIngressAuthorization({
          accountId,
          cfg,
          dmPolicy: effectiveDmPolicy,
          isGroup,
          chatId,
          resolvedThreadId,
          senderId,
          effectiveDmAllow: dmAllow,
          effectiveGroupAllow,
          ownerAccess,
          eventKind: "native-command",
        })
      ).authorized;
  if (requireAuth && !commandAuthorized) {
    return await rejectNotAuthorized();
  }
  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    threadSpec,
    commandAuthorized,
    senderIsOwner: ownerAccess.senderIsOwner,
  };
}

export async function prepareTelegramCommandDispatch(
  params: TelegramCommandExecutorParams & { requireAuth: boolean },
): Promise<TelegramCommandDispatch | null> {
  const telegramDeps = params.telegramDeps ?? defaultTelegramNativeCommandDeps;
  const runtimeCfg = telegramDeps.getRuntimeConfig();
  const runtimeTelegramCfg = resolveTelegramAccount({
    cfg: runtimeCfg,
    accountId: params.accountId,
  }).config;
  const turnSettings = resolveTelegramMessageTurnSettings({
    accountId: params.accountId,
    cfg: runtimeCfg,
    telegramCfg: runtimeTelegramCfg,
    opts: params.opts,
  });
  const auth = await resolveTelegramCommandAuth({
    msg: params.msg,
    bot: params.bot,
    cfg: runtimeCfg,
    accountId: params.accountId,
    telegramCfg: runtimeTelegramCfg,
    readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
    allowFrom: turnSettings.allowFrom,
    groupAllowFrom: turnSettings.groupAllowFrom,
    resolveGroupPolicy: params.resolveGroupPolicy,
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig,
    requireAuth: params.requireAuth,
  });
  if (!auth) {
    return null;
  }
  const { route, bindingMode } = resolveTelegramConversationRoute({
    cfg: runtimeCfg,
    accountId: params.accountId,
    chatId: auth.chatId,
    isGroup: auth.isGroup,
    threadSpec: auth.threadSpec,
    senderId: auth.senderId,
    topicAgentId: auth.topicConfig?.agentId,
  });
  const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
  if (bindingMode.kind === "configured") {
    const ensured = await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
      cfg: runtimeCfg,
      bindingResolution: bindingMode.binding,
    });
    if (!ensured.ok) {
      logVerbose(
        `telegram native command: configured ACP binding unavailable for topic ${bindingMode.binding.record.conversation.conversationId}: ${ensured.error}`,
      );
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime: params.runtime,
        fn: () =>
          params.bot.api.sendMessage(
            auth.chatId,
            "Configured ACP binding is unavailable right now. Please try again.",
            buildTelegramThreadParams(auth.threadSpec) ?? {},
          ),
      });
      return null;
    }
  }
  const mediaLocalRoots = nativeCommandRuntime.getAgentScopedMediaLocalRoots(
    runtimeCfg,
    route.agentId,
  );
  const tableMode = resolveMarkdownTableMode({
    cfg: runtimeCfg,
    channel: "telegram",
    accountId: route.accountId,
    supportsBlockTables: true,
  });
  const chunkMode = nativeCommandRuntime.resolveChunkMode(runtimeCfg, "telegram", route.accountId);
  const targetSessionKey = resolveTelegramTargetSession({
    cfg: runtimeCfg,
    route,
    chatId: auth.chatId,
    isGroup: auth.isGroup,
    senderId: auth.senderId,
    dmThreadId: auth.threadSpec.scope === "dm" ? auth.threadSpec.id : undefined,
    botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(params.botUser),
  });
  const buildDeliveryBaseOptions = (keys?: {
    sessionKeyForInternalHooks?: string;
    policySessionKey?: string;
  }): DeliveryBaseOptions => ({
    cfg: runtimeCfg,
    ownerAgentId: params.opts.ownerAgentId,
    chatId: String(auth.chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: keys?.sessionKeyForInternalHooks,
    policySessionKey: keys?.policySessionKey,
    mirrorIsGroup: auth.isGroup,
    mirrorGroupId: auth.isGroup ? String(auth.chatId) : undefined,
    token: params.opts.token,
    runtime: params.runtime,
    bot: params.bot,
    mediaLocalRoots,
    mediaMaxBytes: params.mediaMaxBytes,
    replyToMode: turnSettings.replyToMode,
    textLimit: turnSettings.textLimit,
    thread: auth.threadSpec,
    tableMode,
    chunkMode,
    linkPreview: runtimeTelegramCfg.linkPreview,
    richMessages: runtimeTelegramCfg.richMessages,
  });
  return {
    ...params,
    telegramDeps,
    runtimeCfg,
    runtimeTelegramCfg,
    turnSettings,
    ...auth,
    threadSpec: auth.threadSpec,
    threadParams: buildTelegramThreadParams(auth.threadSpec),
    route,
    mediaLocalRoots,
    targetSessionKey,
    nativeCommandRuntime,
    buildDeliveryBaseOptions,
    loadDeliveryRuntime: loadTelegramNativeCommandDeliveryRuntime,
  };
}

export async function dispatchTelegramBuiltinTurn(params: {
  dispatch: TelegramCommandDispatch;
  prompt: string;
  commandArgs?: import("openclaw/plugin-sdk/command-auth-native").CommandArgs;
}): Promise<boolean> {
  const { dispatch } = params;
  const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
    groupConfig: dispatch.groupConfig,
    topicConfig: dispatch.topicConfig,
  });
  const { sessionKey: commandSessionKey, commandTargetSessionKey } =
    resolveNativeCommandSessionTargets({
      agentId: dispatch.route.agentId,
      sessionPrefix: "telegram:slash",
      userId: String(dispatch.senderId || dispatch.chatId),
      targetSessionKey: dispatch.targetSessionKey,
    });
  let topicName: string | undefined;
  if (dispatch.isForum && dispatch.resolvedThreadId != null) {
    try {
      const storePath = resolveStorePath(dispatch.runtimeCfg.session?.store, {
        agentId:
          dispatch.opts.ownerAgentId ??
          resolveTelegramAccountOwnerAgentId({
            cfg: dispatch.runtimeCfg,
            accountId: dispatch.route.accountId,
          }),
      });
      topicName = await getTopicName(
        dispatch.chatId,
        dispatch.resolvedThreadId,
        resolveTopicNameCacheScope(storePath),
      );
    } catch {
      // best-effort: topic name is supplementary metadata
    }
  }
  const conversationLabel = dispatch.isGroup
    ? dispatch.msg.chat.title
      ? `${dispatch.msg.chat.title} id:${dispatch.chatId}`
      : `group:${dispatch.chatId}`
    : (buildSenderName(dispatch.msg) ?? String(dispatch.senderId || dispatch.chatId));
  const ctxPayload = dispatch.nativeCommandRuntime.finalizeInboundContext({
    Body: params.prompt,
    BodyForAgent: params.prompt,
    RawBody: params.prompt,
    CommandBody: params.prompt,
    CommandArgs: params.commandArgs,
    From: dispatch.isGroup
      ? buildTelegramGroupFrom(dispatch.chatId, dispatch.threadSpec)
      : `telegram:${dispatch.chatId}`,
    To: `slash:${dispatch.senderId || dispatch.chatId}`,
    ChatType: dispatch.isGroup ? "group" : "direct",
    ...buildTelegramConversationRouteContext(dispatch),
    ConversationToolPolicy: dispatch.isGroup
      ? undefined
      : resolveTelegramDirectToolPolicy({
          directConfig: dispatch.groupConfig,
          senderId: dispatch.senderId,
          senderName: buildSenderName(dispatch.msg),
          senderUsername: dispatch.senderUsername,
        }),
    ConversationLabel: conversationLabel,
    GroupSubject: dispatch.isGroup ? (dispatch.msg.chat.title ?? undefined) : undefined,
    GroupSystemPrompt:
      dispatch.isGroup || (!dispatch.isGroup && dispatch.groupConfig)
        ? groupSystemPrompt
        : undefined,
    SenderName: buildSenderName(dispatch.msg),
    SenderId: dispatch.senderId || undefined,
    SenderUsername: dispatch.senderUsername || undefined,
    Surface: "telegram",
    Provider: "telegram",
    MessageSid: String(dispatch.msg.message_id),
    Timestamp: dispatch.msg.date ? dispatch.msg.date * 1000 : undefined,
    WasMentioned: true,
    CommandAuthorized: dispatch.commandAuthorized,
    CommandTurn: {
      kind: "native" as const,
      source: "native" as const,
      authorized: dispatch.commandAuthorized,
      body: params.prompt,
    },
    CommandSource: "native" as const,
    SessionKey: commandSessionKey,
    AccountId: dispatch.route.accountId,
    CommandTargetSessionKey: commandTargetSessionKey,
    MessageThreadId: dispatch.threadSpec.id,
    IsForum: dispatch.isForum,
    TopicName: dispatch.isForum && topicName ? topicName : undefined,
    OriginatingChannel: "telegram" as const,
    OriginatingTo: buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec),
  });
  const deliveryState = { delivered: false, skippedNonSilent: 0, failedNonSilent: 0 };
  let finalReplyOutcome: "accepted" | "failed" | "suppressed" | undefined;
  let recordSessionMetaTask: Promise<unknown> | undefined;
  const deliveryBaseOptions = dispatch.buildDeliveryBaseOptions({
    sessionKeyForInternalHooks: commandSessionKey,
    policySessionKey: commandTargetSessionKey,
  });
  const { deliverReplies } = await dispatch.loadDeliveryRuntime();
  const turnPlan: ChannelInboundTurnPlan<"provider_message_sending"> = {
    cfg: dispatch.runtimeCfg,
    channel: "telegram",
    accountId: dispatch.route.accountId,
    route: { agentId: dispatch.route.agentId, sessionKey: commandSessionKey },
    ctxPayload,
    record: {
      sessionKey: commandTargetSessionKey,
      trackSessionMetaTask: (task) => {
        recordSessionMetaTask = task;
      },
      onRecordError: (error) =>
        dispatch.runtime.error?.(
          danger(`telegram slash: failed updating session meta: ${String(error)}`),
        ),
    },
    afterRecord: async () => {
      await recordSessionMetaTask;
    },
    replyPipeline: {},
    dispatcherOptions: {
      beforeDeliver: async (payload) => payload,
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") {
          deliveryState.skippedNonSilent += 1;
        }
      },
    },
    delivery: {
      deliverWithProviderMessageSending: async (payload, info) => {
        if (
          shouldSuppressLocalTelegramExecApprovalPrompt({
            cfg: dispatch.runtimeCfg,
            accountId: dispatch.route.accountId,
            payload,
          })
        ) {
          deliveryState.delivered = true;
          return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
        }
        const targetedPayload = payload.replyToId
          ? payload
          : { ...payload, replyToId: String(dispatch.msg.message_id) };
        const result = await deliverReplies({
          replies: [
            info.bindPendingFinalDelivery
              ? info.bindPendingFinalDelivery(targetedPayload)
              : targetedPayload,
          ],
          ...deliveryBaseOptions,
          silent:
            dispatch.runtimeTelegramCfg.silentErrorReplies === true && payload.isError === true,
          onPlatformSendDispatch: info.onPlatformSendDispatch,
        });
        if (result.delivered) {
          deliveryState.delivered = true;
        }
        return result.delivered
          ? { visibleReplySent: true }
          : { visibleReplySent: false, suppression: { reason: "no_visible_result" as const } };
      },
      onDelivered: (_payload, info, result) => {
        const reason = result?.suppression?.reason;
        if (info.kind === "final" && result?.visibleReplySent) {
          finalReplyOutcome = "accepted";
        }
        if (
          info.kind === "final" &&
          finalReplyOutcome !== "failed" &&
          (reason === "cancelled_by_reply_payload_sending_hook" ||
            reason === "empty_after_reply_payload_sending_hook")
        ) {
          finalReplyOutcome = "suppressed";
        }
      },
      onError: (error, info) => {
        deliveryState.failedNonSilent += 1;
        const partialDelivery = isChannelPartialDeliveryError(error);
        if (partialDelivery) {
          deliveryState.delivered = true;
          logVerbose("telegram slash reply partially delivered before failure");
        }
        if (info.kind === "final") {
          finalReplyOutcome = partialDelivery ? "accepted" : "failed";
        }
        dispatch.runtime.error?.(
          danger(`telegram slash ${info.kind} reply failed: ${String(error)}`),
        );
      },
    },
    replyOptions: {
      skillFilter,
      disableBlockStreaming: (() => {
        const enabled = resolveChannelStreamingBlockEnabled(dispatch.runtimeTelegramCfg);
        return typeof enabled === "boolean" ? !enabled : undefined;
      })(),
      [PLUGIN_COMMAND_DISPATCH]: NON_PLUGIN_COMMAND_DISPATCH,
    },
  };
  const turnResult = await (
    dispatch.telegramDeps.dispatchChannelInboundTurn ??
    defaultTelegramNativeCommandDeps.dispatchChannelInboundTurn
  )(turnPlan);
  if (
    !deliveryState.delivered &&
    finalReplyOutcome !== "suppressed" &&
    (deliveryState.skippedNonSilent > 0 || deliveryState.failedNonSilent > 0) &&
    (!turnResult.dispatched ||
      turnResult.dispatchResult.sourceReplyDeliveryMode !== "message_tool_only" ||
      deliveryState.failedNonSilent > 0)
  ) {
    await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      ...deliveryBaseOptions,
    });
  }
  return false;
}
