import type { Bot, Context } from "grammy";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import {
  resolveCommandAuthorization,
  resolveCommandAuthorizedFromAuthorizers,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { isSenderAllowed, normalizeDmAllowFromWithStore } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands as syncTelegramMenuCommandsRuntime,
} from "./bot-native-command-menu.js";
import { TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildSenderName,
  buildTelegramGroupFrom,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import {
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "./command-config.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import type { TelegramTransport } from "./fetch.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordSentMessage } from "./sent-message-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";

type TelegramNativeCommandContext = Context & { match?: string };
type TelegramChunkMode = ReturnType<
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").resolveChunkMode
>;
type TelegramNativeReplyPayload = import("openclaw/plugin-sdk/reply-dispatch-runtime").ReplyPayload;
type TelegramNativeReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
};

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
};

let telegramNativeCommandDeliveryRuntimePromise:
  | Promise<typeof import("./bot-native-commands.delivery.runtime.js")>
  | undefined;

async function loadTelegramNativeCommandDeliveryRuntime() {
  telegramNativeCommandDeliveryRuntimePromise ??=
    import("./bot-native-commands.delivery.runtime.js");
  return await telegramNativeCommandDeliveryRuntimePromise;
}

let telegramNativeCommandRuntimePromise:
  | Promise<typeof import("./bot-native-commands.runtime.js")>
  | undefined;

async function loadTelegramNativeCommandRuntime() {
  telegramNativeCommandRuntimePromise ??= import("./bot-native-commands.runtime.js");
  return await telegramNativeCommandRuntimePromise;
}

function resolveTelegramProgressPlaceholder(command: {
  nativeProgressMessages?: Partial<Record<string, string>> & { default?: string };
}): string | null {
  const text =
    command.nativeProgressMessages?.telegram?.trim() ??
    command.nativeProgressMessages?.default?.trim();
  return text ? text : null;
}

function resolveTelegramNativeReplyChannelData(
  result: TelegramNativeReplyPayload,
): TelegramNativeReplyChannelData | undefined {
  return result.channelData?.telegram as TelegramNativeReplyChannelData | undefined;
}

function isEditableTelegramProgressResult(result: TelegramNativeReplyPayload): boolean {
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    typeof result.text === "string" &&
    result.text.trim() &&
    !result.mediaUrl &&
    (!result.mediaUrls || result.mediaUrls.length === 0) &&
    !result.interactive &&
    !result.btw &&
    telegramData?.pin !== true,
  );
}

async function cleanupTelegramProgressPlaceholder(params: {
  bot: Bot;
  chatId: number;
  progressMessageId?: number;
  runtime: RuntimeEnv;
}): Promise<void> {
  const progressMessageId = params.progressMessageId;
  if (progressMessageId == null) {
    return;
  }
  try {
    await withTelegramApiErrorLogging({
      operation: "deleteMessage",
      runtime: params.runtime,
      fn: () => params.bot.api.deleteMessage(params.chatId, progressMessageId),
    });
  } catch {
    // Best-effort cleanup before fallback or suppression exits.
  }
}

export type RegisterTelegramHandlerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  bot: Bot;
  mediaMaxBytes: number;
  opts: TelegramBotOptions;
  telegramTransport?: TelegramTransport;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  processMessage: (
    ctx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
  ) => Promise<void>;
  logger: ReturnType<typeof getChildLogger>;
};

export function buildTelegramNativeCommandCallbackData(commandText: string): string {
  return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}

export function parseTelegramNativeCommandCallbackData(data?: string | null): string | null {
  if (!data) {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) {
    return null;
  }
  const commandText = trimmed.slice(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX.length).trim();
  return commandText.startsWith("/") ? commandText : null;
}

export function resolveTelegramNativeCommandDisableBlockStreaming(
  telegramCfg: TelegramAccountConfig,
): boolean | undefined {
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  return typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined;
}

export type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: { token: string };
};

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  readChannelAllowFromStore: TelegramBotDeps["readChannelAllowFromStore"];
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    accountId,
    telegramCfg,
    readChannelAllowFromStore,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const getChat =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum = await resolveTelegramForumFlag({
    chatId,
    chatType: msg.chat.type,
    isGroup,
    isForum: extractTelegramForumFlag(msg.chat),
    getChat,
  });
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  const threadParams = buildTelegramThreadParams(threadSpec) ?? {};
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    chatId,
    accountId,
    isGroup,
    isForum,
    messageThreadId,
    groupAllowFrom,
    readChannelAllowFromStore,
    resolveTelegramGroupConfig,
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
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing")
      : (telegramCfg.dmPolicy ?? "pairing");
  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  if (!isGroup && requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  const commandsAllowFrom = cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
  const commandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveCommandAuthorization({
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          AccountId: accountId,
          ChatType: isGroup ? "group" : "direct",
          From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
          SenderId: senderId || undefined,
          SenderUsername: senderUsername || undefined,
        },
        cfg,
        // commands.allowFrom is the only auth source when configured.
        commandAuthorized: false,
      })
    : null;

  const sendAuthMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, text, threadParams),
    });
    return null;
  };
  const rejectNotAuthorized = async () => {
    return await sendAuthMessage("You are not authorized to use this command.");
  };

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
      return await sendAuthMessage("This group is disabled.");
    }
    if (baseAccess.reason === "topic-disabled") {
      return await sendAuthMessage("This topic is disabled.");
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
    resolveGroupPolicy,
    enforcePolicy: useAccessGroups,
    useTopicAndGroupOverrides: false,
    enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: useAccessGroups,
  });
  if (!policyAccess.allowed) {
    if (policyAccess.reason === "group-policy-disabled") {
      return await sendAuthMessage("Telegram group commands are disabled.");
    }
    if (
      policyAccess.reason === "group-policy-allowlist-no-sender" ||
      policyAccess.reason === "group-policy-allowlist-unauthorized"
    ) {
      return await rejectNotAuthorized();
    }
    if (policyAccess.reason === "group-chat-not-allowed") {
      return await sendAuthMessage("This group is not allowed.");
    }
  }

  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const senderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });
  const groupSenderAllowed = isGroup
    ? isSenderAllowed({ allow: effectiveGroupAllow, senderId, senderUsername })
    : false;
  const commandAuthorized = commandsAllowFromConfigured
    ? Boolean(commandsAllowFromAccess?.isAuthorizedSender)
    : resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: dmAllow.hasEntries, allowed: senderAllowed },
          ...(isGroup
            ? [{ configured: effectiveGroupAllow.hasEntries, allowed: groupSenderAllowed }]
            : []),
        ],
        modeWhenAccessGroupsOff: "configured",
      });
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
    commandAuthorized,
  };
}

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  telegramDeps = defaultTelegramNativeCommandDeps,
  opts,
}: RegisterTelegramNativeCommandsParams) => {
  const boundRoute =
    nativeEnabled && nativeSkillsEnabled
      ? resolveAgentRoute({ cfg, channel: "telegram", accountId })
      : null;
  if (nativeEnabled && nativeSkillsEnabled && !boundRoute) {
    runtime.log?.(
      "nativeSkillsEnabled is true but no agent route is bound for this Telegram account; skill commands will not appear in the native menu.",
    );
  }
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled && boundRoute
      ? telegramDeps.listSkillCommandsForAgents({
          cfg,
          agentIds: [boundRoute.agentId],
        })
      : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, {
        skillCommands,
        provider: "telegram",
      })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)),
  );
  for (const command of skillCommands) {
    reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const pluginCommandSpecs =
    (
      telegramDeps.getPluginCommandSpecs ?? defaultTelegramNativeCommandDeps.getPluginCommandSpecs
    )?.("telegram") ?? [];
  const existingCommands = new Set(
    [
      ...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)),
      ...customCommands.map((command) => command.command),
    ].map((command) => normalizeLowercaseStringOrEmpty(command)),
  );
  const pluginCatalog = buildPluginTelegramMenuCommands({
    specs: pluginCommandSpecs,
    existingCommands,
  });
  for (const issue of pluginCatalog.issues) {
    runtime.error?.(danger(issue));
  }
  const loadFreshRuntimeConfig = (): OpenClawConfig => telegramDeps.loadConfig();
  const resolveFreshTelegramConfig = (runtimeCfg: OpenClawConfig): TelegramAccountConfig => {
    try {
      return resolveTelegramAccount({
        cfg: runtimeCfg,
        accountId,
      }).config;
    } catch (error) {
      logVerbose(
        `telegram native command: failed to load fresh account config for ${accountId}; using startup snapshot: ${String(error)}`,
      );
      return telegramCfg;
    }
  };
  const allCommandsFull: Array<{ command: string; description: string }> = [
    ...nativeCommands
      .map((command) => {
        const normalized = normalizeTelegramCommandName(command.name);
        if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
          runtime.error?.(
            danger(
              `Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`,
            ),
          );
          return null;
        }
        return {
          command: normalized,
          description: command.description,
        };
      })
      .filter((cmd): cmd is { command: string; description: string } => cmd !== null),
    ...(nativeEnabled ? pluginCatalog.commands : []),
    ...customCommands,
  ];
  const {
    commandsToRegister,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed,
    textBudgetDropCount,
  } = buildCappedTelegramMenuCommands({
    allCommands: allCommandsFull,
  });
  if (overflowCount > 0) {
    runtime.log?.(
      `Telegram limits bots to ${maxCommands} commands. ` +
        `${totalCommands} configured; registering first ${maxCommands}. ` +
        `Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`,
    );
  }
  if (descriptionTrimmed) {
    runtime.log?.(
      `Telegram menu text exceeded the conservative ${maxTotalChars}-character payload budget; shortening descriptions to keep ${commandsToRegister.length} commands visible.`,
    );
  }
  if (textBudgetDropCount > 0) {
    runtime.log?.(
      `Telegram menu text still exceeded the conservative ${maxTotalChars}-character payload budget after shortening descriptions; registering first ${commandsToRegister.length} commands.`,
    );
  }
  const syncTelegramMenuCommands =
    telegramDeps.syncTelegramMenuCommands ?? syncTelegramMenuCommandsRuntime;
  // Telegram only limits the setMyCommands payload (menu entries).
  // Keep hidden commands callable by registering handlers for the full catalog.
  syncTelegramMenuCommands({
    bot,
    runtime,
    commandsToRegister,
    accountId,
    botIdentity: opts.token,
  });

  const resolveCommandRuntimeContext = async (params: {
    msg: NonNullable<TelegramNativeCommandContext["message"]>;
    runtimeCfg: OpenClawConfig;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    senderId?: string;
    topicAgentId?: string;
  }): Promise<{
    chatId: number;
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
    mediaLocalRoots: readonly string[] | undefined;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: TelegramChunkMode;
  } | null> => {
    const { msg, runtimeCfg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
    const chatId = msg.chat.id;
    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadSpec = resolveTelegramThreadSpec({
      isGroup,
      isForum,
      messageThreadId: resolvedThreadId ?? messageThreadId,
    });
    let { route, configuredBinding } = resolveTelegramConversationRoute({
      cfg: runtimeCfg,
      accountId,
      chatId,
      isGroup,
      resolvedThreadId,
      replyThreadId: threadSpec.id,
      senderId,
      topicAgentId,
    });
    const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
    if (configuredBinding) {
      const ensured = await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
        cfg: runtimeCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        logVerbose(
          `telegram native command: configured ACP binding unavailable for topic ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
        );
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              chatId,
              "Configured ACP binding is unavailable right now. Please try again.",
              buildTelegramThreadParams(threadSpec) ?? {},
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
    });
    const chunkMode = nativeCommandRuntime.resolveChunkMode(
      runtimeCfg,
      "telegram",
      route.accountId,
    );
    return { chatId, threadSpec, route, mediaLocalRoots, tableMode, chunkMode };
  };
  const buildCommandDeliveryBaseOptions = (params: {
    chatId: string | number;
    accountId: string;
    sessionKeyForInternalHooks?: string;
    mirrorIsGroup?: boolean;
    mirrorGroupId?: string;
    mediaLocalRoots?: readonly string[];
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: TelegramChunkMode;
    linkPreview?: boolean;
  }) => ({
    chatId: String(params.chatId),
    accountId: params.accountId,
    sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
    mirrorIsGroup: params.mirrorIsGroup,
    mirrorGroupId: params.mirrorGroupId,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots: params.mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: params.threadSpec,
    tableMode: params.tableMode,
    chunkMode: params.chunkMode,
    linkPreview: params.linkPreview,
  });

  if (commandsToRegister.length > 0 || pluginCatalog.commands.length > 0) {
    for (const command of nativeCommands) {
      const normalizedCommandName = normalizeTelegramCommandName(command.name);
      bot.command(normalizedCommandName, async (ctx: TelegramNativeCommandContext) => {
        const msg = ctx.message;
        if (!msg) {
          return;
        }
        if (shouldSkipUpdate(ctx)) {
          return;
        }
        const runtimeCfg = loadFreshRuntimeConfig();
        const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
        const auth = await resolveTelegramCommandAuth({
          msg,
          bot,
          cfg: runtimeCfg,
          accountId,
          telegramCfg: runtimeTelegramCfg,
          readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
          allowFrom,
          groupAllowFrom,
          useAccessGroups,
          resolveGroupPolicy,
          resolveTelegramGroupConfig,
          requireAuth: true,
        });
        if (!auth) {
          return;
        }
        const {
          chatId,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          senderUsername,
          groupConfig,
          topicConfig,
          commandAuthorized,
        } = auth;
        const runtimeContext = await resolveCommandRuntimeContext({
          msg,
          runtimeCfg,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          topicAgentId: topicConfig?.agentId,
        });
        if (!runtimeContext) {
          return;
        }
        const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
        const threadParams = buildTelegramThreadParams(threadSpec) ?? {};
        const originatingTo = buildTelegramRoutingTarget(chatId, threadSpec);
        const executionCfg = getRuntimeConfigSnapshot() ?? cfg;

        const commandDefinition = findCommandByNativeName(command.name, "telegram");
        const rawText = ctx.match?.trim() ?? "";
        const commandArgs = commandDefinition
          ? parseCommandArgs(commandDefinition, rawText)
          : rawText
            ? ({ raw: rawText } satisfies CommandArgs)
            : undefined;
        const prompt = commandDefinition
          ? buildCommandTextFromArgs(commandDefinition, commandArgs)
          : rawText
            ? `/${command.name} ${rawText}`
            : `/${command.name}`;
        const menu = commandDefinition
          ? resolveCommandArgMenu({
              command: commandDefinition,
              args: commandArgs,
              cfg: runtimeCfg,
            })
          : null;
        if (menu && commandDefinition) {
          const title =
            menu.title ??
            `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
          const rows: Array<Array<{ text: string; callback_data: string }>> = [];
          for (let i = 0; i < menu.choices.length; i += 2) {
            const slice = menu.choices.slice(i, i + 2);
            rows.push(
              slice.map((choice) => {
                const args: CommandArgs = {
                  values: { [menu.arg.name]: choice.value },
                };
                return {
                  text: choice.label,
                  callback_data: buildTelegramNativeCommandCallbackData(
                    buildCommandTextFromArgs(commandDefinition, args),
                  ),
                };
              }),
            );
          }
          const replyMarkup = buildInlineKeyboard(rows);
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, title, {
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                ...threadParams,
              }),
          });
          return;
        }
        const baseSessionKey = resolveTelegramConversationBaseSessionKey({
          cfg: runtimeCfg,
          route,
          chatId,
          isGroup,
          senderId,
        });
        // DMs: use raw messageThreadId for thread sessions (not resolvedThreadId which is for forums)
        const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
        const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
        const threadKeys =
          dmThreadId != null
            ? nativeCommandRuntime.resolveThreadSessionKeys({
                baseSessionKey,
                threadId: `${chatId}:${dmThreadId}`,
              })
            : null;
        const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
        const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
          groupConfig,
          topicConfig,
        });
        const { sessionKey: commandSessionKey, commandTargetSessionKey } =
          resolveNativeCommandSessionTargets({
            agentId: route.agentId,
            sessionPrefix: "telegram:slash",
            userId: String(senderId || chatId),
            targetSessionKey: sessionKey,
          });
        const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: commandSessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          linkPreview: runtimeTelegramCfg.linkPreview,
        });
        const conversationLabel = isGroup
          ? msg.chat.title
            ? `${msg.chat.title} id:${chatId}`
            : `group:${chatId}`
          : (buildSenderName(msg) ?? String(senderId || chatId));
        const ctxPayload = nativeCommandRuntime.finalizeInboundContext({
          Body: prompt,
          BodyForAgent: prompt,
          RawBody: prompt,
          CommandBody: prompt,
          CommandArgs: commandArgs,
          From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
          To: `slash:${senderId || chatId}`,
          ChatType: isGroup ? "group" : "direct",
          ConversationLabel: conversationLabel,
          GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
          GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
          SenderName: buildSenderName(msg),
          SenderId: senderId || undefined,
          SenderUsername: senderUsername || undefined,
          Surface: "telegram",
          Provider: "telegram",
          MessageSid: String(msg.message_id),
          Timestamp: msg.date ? msg.date * 1000 : undefined,
          WasMentioned: true,
          CommandAuthorized: commandAuthorized,
          CommandSource: "native" as const,
          SessionKey: commandSessionKey,
          AccountId: route.accountId,
          CommandTargetSessionKey: commandTargetSessionKey,
          MessageThreadId: threadSpec.id,
          IsForum: isForum,
          // Originating context for sub-agent announce routing
          OriginatingChannel: "telegram" as const,
          OriginatingTo: originatingTo,
        });

        await nativeCommandRuntime.recordInboundSessionMetaSafe({
          cfg: executionCfg,
          agentId: route.agentId,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
          onError: (err) =>
            runtime.error?.(danger(`telegram slash: failed updating session meta: ${String(err)}`)),
        });

        const disableBlockStreaming =
          resolveTelegramNativeCommandDisableBlockStreaming(runtimeTelegramCfg);
        const deliveryState = {
          delivered: false,
          skippedNonSilent: 0,
        };

        const { createChannelReplyPipeline, deliverReplies } =
          await loadTelegramNativeCommandDeliveryRuntime();
        const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
          cfg: executionCfg,
          agentId: route.agentId,
          channel: "telegram",
          accountId: route.accountId,
        });

        await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: executionCfg,
          dispatcherOptions: {
            ...replyPipeline,
            deliver: async (payload, _info) => {
              if (
                shouldSuppressLocalTelegramExecApprovalPrompt({
                  cfg: executionCfg,
                  accountId: route.accountId,
                  payload,
                })
              ) {
                deliveryState.delivered = true;
                return;
              }
              const result = await deliverReplies({
                replies: [
                  payload.replyToId
                    ? payload
                    : {
                        ...payload,
                        replyToId: String(msg.message_id),
                      },
                ],
                ...deliveryBaseOptions,
                silent: runtimeTelegramCfg.silentErrorReplies === true && payload.isError === true,
              });
              if (result.delivered) {
                deliveryState.delivered = true;
              }
            },
            onSkip: (_payload, info) => {
              if (info.reason !== "silent") {
                deliveryState.skippedNonSilent += 1;
              }
            },
            onError: (err, info) => {
              runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {
            skillFilter,
            disableBlockStreaming,
            onModelSelected,
          },
        });
        if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
          await deliverReplies({
            replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
            ...deliveryBaseOptions,
          });
        }
      });
    }

    for (const pluginCommand of pluginCatalog.commands) {
      bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
        const msg = ctx.message;
        if (!msg) {
          return;
        }
        if (shouldSkipUpdate(ctx)) {
          return;
        }
        const chatId = msg.chat.id;
        const runtimeCfg = loadFreshRuntimeConfig();
        const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
        const rawText = ctx.match?.trim() ?? "";
        const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
        const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
        const match = nativeCommandRuntime.matchPluginCommand(commandBody);
        if (!match) {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () => bot.api.sendMessage(chatId, "Command not found."),
          });
          return;
        }
        const auth = await resolveTelegramCommandAuth({
          msg,
          bot,
          cfg: runtimeCfg,
          accountId,
          telegramCfg: runtimeTelegramCfg,
          readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
          allowFrom,
          groupAllowFrom,
          useAccessGroups,
          resolveGroupPolicy,
          resolveTelegramGroupConfig,
          requireAuth: match.command.requireAuth !== false,
        });
        if (!auth) {
          return;
        }
        const { senderId, commandAuthorized, isGroup, isForum, resolvedThreadId } = auth;
        const runtimeContext = await resolveCommandRuntimeContext({
          msg,
          runtimeCfg,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          topicAgentId: auth.topicConfig?.agentId,
        });
        if (!runtimeContext) {
          return;
        }
        const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
        const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: route.sessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          linkPreview: runtimeTelegramCfg.linkPreview,
        });
        const from = isGroup ? buildTelegramGroupFrom(chatId, threadSpec.id) : `telegram:${chatId}`;
        const to = `telegram:${chatId}`;
        const { deliverReplies, emitTelegramMessageSentHooks } =
          await loadTelegramNativeCommandDeliveryRuntime();
        let progressMessageId: number | undefined;
        const progressPlaceholder = resolveTelegramProgressPlaceholder(match.command);

        if (progressPlaceholder) {
          try {
            const sent = await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(
                  chatId,
                  progressPlaceholder,
                  buildTelegramThreadParams(threadSpec),
                ),
            });
            const maybeMessageId = (sent as { message_id?: unknown } | undefined)?.message_id;
            if (typeof maybeMessageId === "number") {
              progressMessageId = maybeMessageId;
            }
          } catch {
            // Fall back to the normal final reply path if the placeholder send fails.
          }
        }

        const result = await nativeCommandRuntime.executePluginCommand({
          command: match.command,
          args: match.args,
          senderId,
          channel: "telegram",
          isAuthorizedSender: commandAuthorized,
          sessionKey: route.sessionKey,
          commandBody,
          config: runtimeCfg,
          from,
          to,
          accountId,
          messageThreadId: threadSpec.id,
        });

        if (
          shouldSuppressLocalTelegramExecApprovalPrompt({
            cfg: runtimeCfg,
            accountId: route.accountId,
            payload: result,
          })
        ) {
          await cleanupTelegramProgressPlaceholder({
            bot,
            chatId,
            progressMessageId,
            runtime,
          });
          return;
        }

        const progressResultText =
          typeof result.text === "string" && result.text.trim().length > 0 ? result.text : null;
        const telegramResultData = resolveTelegramNativeReplyChannelData(result);
        if (
          progressMessageId != null &&
          telegramDeps.editMessageTelegram &&
          progressResultText &&
          isEditableTelegramProgressResult(result)
        ) {
          try {
            await telegramDeps.editMessageTelegram(chatId, progressMessageId, progressResultText, {
              cfg: runtimeCfg,
              accountId: route.accountId,
              textMode: "markdown",
              linkPreview: runtimeTelegramCfg.linkPreview,
              buttons: telegramResultData?.buttons,
            });
            recordSentMessage(chatId, progressMessageId);
            emitTelegramMessageSentHooks({
              sessionKeyForInternalHooks: route.sessionKey,
              chatId: String(chatId),
              accountId: route.accountId,
              content: progressResultText,
              success: true,
              messageId: progressMessageId,
              isGroup,
              groupId: isGroup ? String(chatId) : undefined,
            });
            return;
          } catch {
            // Fall through to cleanup + normal delivered reply if editing fails.
          }
        }
        await cleanupTelegramProgressPlaceholder({
          bot,
          chatId,
          progressMessageId,
          runtime,
        });
        await deliverReplies({
          replies: [result],
          ...deliveryBaseOptions,
          silent: runtimeTelegramCfg.silentErrorReplies === true && result.isError === true,
        });
      });
    }
  } else if (nativeDisabledExplicit) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
  }
};
