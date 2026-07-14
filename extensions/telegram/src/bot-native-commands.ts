// Telegram plugin module implements bot native commands behavior.
import { randomUUID } from "node:crypto";
import type { Bot, Context } from "grammy";
import {
  loadModelCatalog,
  resolveAgentConfig,
  resolveDefaultModelForAgent,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth-native";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatFastModeCurrentStatus,
  formatCommandArgMenuTitle,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveEffectiveAgentRuntime,
  resolveCommandArgMenu,
  resolveFastModeState,
  resolveStoredModelOverride,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-contracts";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { codexChannelLoginRuntime } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  formatSqliteSessionFileMarker,
  getSessionEntry,
  resolveStorePath,
  type SessionEntry,
  updateSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeDmAllowFromWithStore, resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import {
  resolveTelegramMessageTurnSettings,
  type TelegramMessageProcessorTurnContext,
} from "./bot-message.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands as syncTelegramMenuCommandsRuntime,
  type TelegramMenuCommand,
} from "./bot-native-command-menu.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildSenderName,
  buildTelegramGroupFrom,
  extractTelegramForumFlag,
  isTelegramCommandsAllowFromConfigured,
  resolveTelegramCommandAuthorization,
  resolveTelegramForumFlag,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramThreadSpec,
  shouldUseTelegramDmThreadSession,
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
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { getTopicName, resolveTopicNameCacheScope } from "./topic-name-cache.js";

export { parseTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const activeTelegramCodexLoginFlows = new Map<string, { expiresAt: number }>();

type TelegramNativeCommandContext = Context & { match?: string };
type TelegramChunkMode = ReturnType<
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").resolveChunkMode
>;
type TelegramNativeReplyPayload = import("openclaw/plugin-sdk/plugin-entry").PluginCommandResult;
type TelegramNativeReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
  reaction?: {
    emoji?: unknown;
  };
};
type FastModeState = ReturnType<typeof resolveFastModeState>;
type TelegramResolvedGroupConfig = {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
  senderIsOwner: boolean;
};

type TelegramNativeCommandThreadContext = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId: number | undefined;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  threadParams: ReturnType<typeof buildTelegramThreadParams>;
};

function resolveTelegramCodexLoginProviderInput(commandArgs: CommandArgs | undefined): string {
  const providerValue = commandArgs?.values?.provider;
  return typeof providerValue === "string" && providerValue.trim()
    ? providerValue
    : (commandArgs?.raw ?? "codex");
}

function buildTelegramCodexLoginFlowKey(params: {
  accountId: string;
  chatId: number;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  agentId: string;
  provider: string;
}): string {
  const threadKey =
    params.threadSpec.id == null
      ? params.threadSpec.scope
      : `${params.threadSpec.scope}:${params.threadSpec.id}`;
  return [
    "telegram",
    params.accountId,
    String(params.chatId),
    threadKey,
    params.agentId,
    params.provider,
  ].join(":");
}

type TelegramCommandMenuModelContext = {
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  fastMode?: SessionEntry["fastMode"];
};

function buildTelegramCommandMenuModelContext(params: {
  provider: string;
  model: string;
  thinkingLevel?: string;
  fastMode?: SessionEntry["fastMode"];
}): TelegramCommandMenuModelContext {
  return {
    provider: params.provider,
    model: params.model,
    ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
  };
}

const loadTelegramNativeCommandDeliveryRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.delivery.runtime.js"),
);

const loadTelegramNativeCommandRuntime = createLazyRuntimeModule(
  () => import("./bot-native-commands.runtime.js"),
);

export const testing = {
  loadNativeCommandRuntime: loadTelegramNativeCommandRuntime,
};
export { testing as __testing };

type TelegramNativeCommandRuntime = Awaited<ReturnType<typeof loadTelegramNativeCommandRuntime>>;

function resolveTelegramCommandSessionFile(params: {
  agentId: string;
  sessionFile?: string;
  sessionId: string;
  storePath: string;
}): string {
  const sqliteMarker = formatSqliteSessionFileMarker({
    agentId: params.agentId,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
  const explicitSessionFile = params.sessionFile?.trim();
  if (explicitSessionFile === sqliteMarker) {
    return explicitSessionFile;
  }
  return sqliteMarker;
}

function resolveTelegramProgressPlaceholder(command: {
  nativeProgressMessages?: Partial<Record<string, string>> & { default?: string };
}): string | null {
  const text =
    command.nativeProgressMessages?.telegram?.trim() ??
    command.nativeProgressMessages?.default?.trim();
  return text ? text : null;
}

async function resolveTelegramCommandTranscriptContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  threadId?: string | number;
}): Promise<{ sessionId?: string; sessionFile?: string; authProfileId?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({
      agentId: params.agentId,
      sessionKey,
      storePath,
    });
    const sessionId = entry?.sessionId?.trim() || randomUUID();
    const sessionFile = resolveTelegramCommandSessionFile({
      agentId: params.agentId,
      sessionFile: entry?.sessionFile,
      sessionId,
      storePath,
    });
    const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
    return {
      sessionId,
      sessionFile,
      ...(authProfileId ? { authProfileId } : {}),
    };
  } catch {
    return {};
  }
}

function resolveTelegramCommandMenuModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): TelegramCommandMenuModelContext {
  if (!params.sessionKey.trim()) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    const thinkingLevel = normalizeOptionalString(entry?.thinkingLevel);
    const fastMode = entry?.fastMode;
    let context: TelegramCommandMenuModelContext;
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      context = buildTelegramCommandMenuModelContext({
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(fastMode !== undefined ? { fastMode } : {}),
      });
    } else {
      const override = resolveStoredModelOverride({
        sessionEntry: entry,
        loadSessionEntry: (sessionKey) => getSessionEntry({ storePath, sessionKey }),
        sessionKey: params.sessionKey,
        defaultProvider: defaultModel.provider,
      });
      if (override?.model) {
        context = buildTelegramCommandMenuModelContext({
          provider: override.provider || defaultModel.provider,
          model: override.model,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
        });
      } else {
        const provider =
          normalizeOptionalString(entry?.providerOverride) ??
          normalizeOptionalString(entry?.modelProvider);
        const model =
          normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
        context = {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
        };
      }
    }
    return {
      ...context,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: context.provider ?? defaultModel.provider,
        modelId: context.model ?? defaultModel.model,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: entry,
      }),
    };
  } catch {
    return {};
  }
}

function resolveTelegramFastCommandModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): {
  provider?: string;
  model?: string;
} {
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const fallback = () => ({
    provider: defaultModel.provider,
    model: defaultModel.model,
  });
  if (!params.sessionKey.trim()) {
    return fallback();
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      return fallback();
    }
    const override = resolveStoredModelOverride({
      sessionEntry: entry,
      loadSessionEntry: (sessionKey) => getSessionEntry({ storePath, sessionKey }),
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    return {
      provider: override?.provider ?? defaultModel.provider,
      model: override?.model ?? defaultModel.model,
    };
  } catch {
    return fallback();
  }
}

function resolveTelegramFastCommandState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): FastModeState {
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const fallback = () =>
    resolveFastModeState({
      cfg: params.cfg,
      provider: defaultModel.provider,
      model: defaultModel.model,
      agentId: params.agentId,
    });
  if (!params.sessionKey.trim()) {
    return fallback();
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const entry = getSessionEntry({ storePath, sessionKey: params.sessionKey });
    const modelContext = resolveTelegramFastCommandModelContext(params);
    return resolveFastModeState({
      cfg: params.cfg,
      provider: modelContext.provider ?? defaultModel.provider,
      model: modelContext.model ?? defaultModel.model,
      agentId: params.agentId,
      sessionEntry:
        entry?.fastMode !== undefined
          ? {
              fastMode: entry.fastMode,
            }
          : undefined,
    });
  } catch {
    return fallback();
  }
}

async function resolveTelegramThinkMenuCurrentLevel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  catalog: Awaited<ReturnType<typeof loadModelCatalog>>;
}): Promise<string> {
  const explicit = normalizeOptionalString(params.thinkingLevel);
  if (explicit) {
    return explicit;
  }
  const agentThinkingDefault = normalizeOptionalString(
    resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault,
  );
  if (agentThinkingDefault) {
    return agentThinkingDefault;
  }
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return await resolveThinkingDefaultWithRuntimeCatalog({
    cfg: params.cfg,
    provider: params.provider ?? defaultModel.provider,
    model: params.model ?? defaultModel.model,
    agentRuntime: params.agentRuntime,
    loadModelCatalog: async () => params.catalog,
  });
}

function formatTelegramCommandArgMenuTitle(params: {
  command: NonNullable<ReturnType<typeof findCommandByNativeName>>;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenu>>;
  currentThinkingLevel?: string;
  currentFastModeStatus?: string;
}): string {
  const title = formatCommandArgMenuTitle({ command: params.command, menu: params.menu });
  if (params.command.key === "think" && params.currentThinkingLevel) {
    return `Current thinking level: ${params.currentThinkingLevel}.\n${title}`;
  }
  if (params.command.key === "fast" && params.currentFastModeStatus) {
    const options = params.menu.choices
      .map((choice) => choice.label.trim())
      .filter(Boolean)
      .join(", ");
    return options
      ? `${params.currentFastModeStatus}\nOptions: ${options}.`
      : params.currentFastModeStatus;
  }
  return title;
}

function resolveTelegramFastMenuCurrentStatus(params: { state: FastModeState }): string {
  return formatFastModeCurrentStatus({
    mode: params.state.mode,
    source: params.state.source,
    fastAutoOnSeconds: params.state.fastAutoOnSeconds,
  });
}

function resolveTelegramNativeReplyChannelData(
  result: TelegramNativeReplyPayload,
): TelegramNativeReplyChannelData | undefined {
  return result.channelData?.telegram as TelegramNativeReplyChannelData | undefined;
}

function normalizeTelegramNativeReplyPayload(
  result: TelegramNativeReplyPayload | null | undefined,
): TelegramNativeReplyPayload {
  return result && typeof result === "object" ? result : {};
}

function isSuppressedTelegramNativeReplyPayload(result: TelegramNativeReplyPayload): boolean {
  return result.suppressReply === true;
}

function hasTelegramNativeReplyReaction(result: TelegramNativeReplyPayload): boolean {
  const reactionEmoji = resolveTelegramNativeReplyChannelData(result)?.reaction?.emoji;
  return typeof reactionEmoji === "string" && reactionEmoji.trim().length > 0;
}

function hasRenderableTelegramNativeReplyPayload(result: TelegramNativeReplyPayload): boolean {
  const { channelData: _channelData, ...portableContent } = result;
  if (hasOutboundReplyContent(portableContent, { trimText: true })) {
    return true;
  }
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    buildInlineKeyboard(telegramData?.buttons) || hasTelegramNativeReplyReaction(result),
  );
}

function isEditableTelegramProgressResult(result: TelegramNativeReplyPayload): boolean {
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    typeof result.text === "string" &&
    result.text.trim() &&
    !result.mediaUrl &&
    (!result.mediaUrls || result.mediaUrls.length === 0) &&
    !result.presentation &&
    !result.interactive &&
    !result.btw &&
    !hasTelegramNativeReplyReaction(result) &&
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

async function resolveTelegramNativeCommandThreadContext(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
}): Promise<TelegramNativeCommandThreadContext> {
  const { msg, bot } = params;
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
    isTopicMessage: msg.is_topic_message,
    getChat,
  });
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  return {
    chatId,
    isGroup,
    isForum,
    messageThreadId,
    threadSpec,
    threadParams: buildTelegramThreadParams(threadSpec),
  };
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
  telegramDeps: TelegramBotDeps;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveGroupActivation: (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
    cfg: OpenClawConfig;
  }) => boolean | undefined;
  resolveGroupRequireMention: (chatId: string | number, cfg: OpenClawConfig) => boolean;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  processMessage: (
    ctx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    turnContext: TelegramMessageProcessorTurnContext,
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: import("./message-cache.js").TelegramReplyChainEntry[],
    promptContext?: import("./bot-message-context.types.js").TelegramPromptContextEntry[],
  ) => Promise<TelegramMessageProcessingResult>;
  logger: ReturnType<typeof getChildLogger>;
};

function resolveTelegramNativeCommandDisableBlockStreaming(
  telegramCfg: TelegramAccountConfig,
): boolean | undefined {
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  return typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined;
}

type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  mediaMaxBytes?: number;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: Pick<TelegramBotOptions, "token" | "allowFrom" | "groupAllowFrom" | "replyToMode">;
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
  resolveGroupPolicy: (chatId: string | number, cfg: OpenClawConfig) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId: number | undefined,
    cfg: OpenClawConfig,
  ) => TelegramResolvedGroupConfig;
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
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const { chatId, isGroup, isForum, messageThreadId, threadParams } =
    await resolveTelegramNativeCommandThreadContext({ msg, bot });
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  // Best-effort pre-context check: if commands.allowFrom already authorizes the
  // sender at chat level, skip the pairing-store read so a transient store I/O
  // failure cannot block a command this sender is explicitly allowed to run.
  // resolvedThreadId is not known yet; the post-context check below is still
  // the authoritative decision for topic-scoped command auth.
  const commandsAllowFromConfigured = isTelegramCommandsAllowFromConfigured(cfg);
  const preContextCommandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveTelegramCommandAuthorization({
        cfg,
        accountId,
        chatId,
        isGroup,
        senderId,
        senderUsername,
      })
    : null;
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    cfg,
    chatId,
    accountId,
    dmPolicy: telegramCfg.dmPolicy,
    allowFrom,
    senderId,
    isGroup,
    isForum,
    messageThreadId,
    groupAllowFrom,
    skipPairingStoreRead: Boolean(preContextCommandsAllowFromAccess?.isAuthorizedSender),
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
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const commandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveTelegramCommandAuthorization({
        cfg,
        accountId,
        chatId,
        isGroup,
        resolvedThreadId,
        senderId,
        senderUsername,
      })
    : null;
  const ownerAccess = resolveTelegramCommandAuthorization({
    cfg,
    accountId,
    chatId,
    isGroup,
    resolvedThreadId,
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
    enforcePolicy: cfg.commands?.useAccessGroups !== false,
    useTopicAndGroupOverrides: false,
    enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: cfg.commands?.useAccessGroups !== false,
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

  const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: dmAllowFrom,
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
    commandAuthorized,
    senderIsOwner: ownerAccess.senderIsOwner,
  };
}

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  mediaMaxBytes,
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
  const pluginCommandSpecs =
    (
      telegramDeps.getPluginCommandSpecs ?? defaultTelegramNativeCommandDeps.getPluginCommandSpecs
    )?.("telegram", { config: cfg }) ?? [];
  const resolveTelegramMenuCommandCatalog = (
    activeSkillCommands: typeof skillCommands,
    reservedSkillCommands = activeSkillCommands,
  ) => {
    const nativeCommands = nativeEnabled
      ? listNativeCommandSpecsForConfig(cfg, {
          skillCommands: activeSkillCommands,
          provider: "telegram",
        })
      : [];
    const reservedCommands = new Set(
      listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)),
    );
    for (const command of reservedSkillCommands) {
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
    const existingCommands = new Set(
      [
        ...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)),
        ...customCommands.map((command) => command.command),
      ].map((command) => normalizeLowercaseStringOrEmpty(command)),
    );
    for (const command of reservedSkillCommands) {
      existingCommands.add(normalizeTelegramCommandName(command.name));
    }
    const pluginCatalog = buildPluginTelegramMenuCommands({
      specs: pluginCommandSpecs,
      existingCommands,
    });
    for (const issue of pluginCatalog.issues) {
      runtime.error?.(danger(issue));
    }
    const allCommandsFull: TelegramMenuCommand[] = [
      ...nativeCommands
        .map((command): TelegramMenuCommand | null => {
          const normalized = normalizeTelegramCommandName(command.name);
          if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
            runtime.error?.(
              danger(
                `Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`,
              ),
            );
            return null;
          }
          const menuCommand: TelegramMenuCommand = {
            command: normalized,
            description: command.description,
          };
          if (command.isAlias) {
            menuCommand.isAlias = true;
          }
          if (command.descriptionLocalizations) {
            menuCommand.descriptionLocalizations = command.descriptionLocalizations;
          }
          return menuCommand;
        })
        .filter((cmd) => cmd !== null),
      ...(nativeEnabled ? pluginCatalog.commands : []),
      ...customCommands,
    ];
    return {
      nativeCommands,
      customCommands,
      pluginCatalog,
      ...buildCappedTelegramMenuCommands({
        allCommands: allCommandsFull,
      }),
    };
  };
  const fullCommandCatalog = resolveTelegramMenuCommandCatalog(skillCommands);
  let menuCommandCatalog = fullCommandCatalog;
  if (
    nativeEnabled &&
    nativeSkillsEnabled &&
    skillCommands.length > 0 &&
    fullCommandCatalog.overflowCount > 0
  ) {
    const initialCommandCount = fullCommandCatalog.totalCommands;
    menuCommandCatalog = resolveTelegramMenuCommandCatalog([], skillCommands);
    runtime.log?.(
      `${initialCommandCount} commands exceed the ${fullCommandCatalog.maxCommands}-command Telegram limit; removing per-skill commands and keeping /skill.`,
    );
  }
  const { nativeCommands, pluginCatalog } = fullCommandCatalog;
  const loadFreshRuntimeConfig = (): OpenClawConfig => telegramDeps.getRuntimeConfig();
  const resolveFreshTelegramConfig = (runtimeCfg: OpenClawConfig): TelegramAccountConfig =>
    resolveTelegramAccount({ cfg: runtimeCfg, accountId }).config;
  const {
    commandsToRegister,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed,
    textBudgetDropCount,
  } = menuCommandCatalog;
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
    const { route, bindingMode } = resolveTelegramConversationRoute({
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
      supportsBlockTables: true,
    });
    const chunkMode = nativeCommandRuntime.resolveChunkMode(
      runtimeCfg,
      "telegram",
      route.accountId,
    );
    return { chatId, threadSpec, route, mediaLocalRoots, tableMode, chunkMode };
  };
  const buildCommandDeliveryBaseOptions = (params: {
    cfg: OpenClawConfig;
    chatId: string | number;
    accountId: string;
    sessionKeyForInternalHooks?: string;
    policySessionKey?: string;
    mirrorIsGroup?: boolean;
    mirrorGroupId?: string;
    mediaLocalRoots?: readonly string[];
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: TelegramChunkMode;
    replyToMode: ReplyToMode;
    textLimit: number;
    linkPreview?: boolean;
    richMessages?: boolean;
  }) => ({
    cfg: params.cfg,
    chatId: String(params.chatId),
    accountId: params.accountId,
    sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
    policySessionKey: params.policySessionKey,
    mirrorIsGroup: params.mirrorIsGroup,
    mirrorGroupId: params.mirrorGroupId,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaMaxBytes,
    replyToMode: params.replyToMode,
    textLimit: params.textLimit,
    thread: params.threadSpec,
    tableMode: params.tableMode,
    chunkMode: params.chunkMode,
    linkPreview: params.linkPreview,
    richMessages: params.richMessages,
  });
  const resolveCommandTargetSessionKey = (params: {
    runtimeCfg: OpenClawConfig;
    route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
    chatId: number;
    isGroup: boolean;
    senderId?: string;
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    botHasTopicsEnabled?: boolean;
    resolveThreadSessionKeys: TelegramNativeCommandRuntime["resolveThreadSessionKeys"];
  }): string => {
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg: params.runtimeCfg,
      route: params.route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
    });
    const dmThreadId = params.threadSpec.scope === "dm" ? params.threadSpec.id : undefined;
    const threadKeys =
      shouldUseTelegramDmThreadSession({
        dmThreadId,
        botHasTopicsEnabled: params.botHasTopicsEnabled,
      }) && dmThreadId != null
        ? params.resolveThreadSessionKeys({
            baseSessionKey,
            threadId: `${params.chatId}:${dmThreadId}`,
          })
        : null;
    return threadKeys?.sessionKey ?? baseSessionKey;
  };

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
        const turnSettings = resolveTelegramMessageTurnSettings({
          accountId,
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          opts,
        });
        const auth = await resolveTelegramCommandAuth({
          msg,
          bot,
          cfg: runtimeCfg,
          accountId,
          telegramCfg: runtimeTelegramCfg,
          readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
          allowFrom: turnSettings.allowFrom,
          groupAllowFrom: turnSettings.groupAllowFrom,
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
          senderIsOwner,
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

        if (commandDefinition?.key === "login") {
          const sendLoginMessage = async (text: string) => {
            await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () => bot.api.sendMessage(chatId, text, threadParams),
            });
          };
          if (
            !senderIsOwner ||
            !codexChannelLoginRuntime.hasConfiguredCommandOwnerAllowlist(runtimeCfg)
          ) {
            await sendLoginMessage(
              "Only a configured OpenClaw owner can start Codex login from Telegram.",
            );
            return;
          }
          if (isGroup) {
            await sendLoginMessage(
              "For safety, Codex login codes are only sent in a private chat with this bot. DM this bot `/login codex` to pair Codex.",
            );
            return;
          }
          const loginProvider = codexChannelLoginRuntime.resolveProvider(
            resolveTelegramCodexLoginProviderInput(commandArgs),
          );
          if (!loginProvider) {
            await sendLoginMessage("Unsupported login provider. Use `/login codex`.");
            return;
          }
          const flowKey = buildTelegramCodexLoginFlowKey({
            accountId: route.accountId,
            chatId,
            threadSpec,
            agentId: route.agentId,
            provider: loginProvider,
          });
          const reservation = codexChannelLoginRuntime.reserveFlow({
            flows: activeTelegramCodexLoginFlows,
            flowKey,
          });
          if (reservation.status === "active") {
            await sendLoginMessage(
              "A Codex login code is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.",
            );
            return;
          }
          try {
            const loginFlow =
              telegramDeps.runModelsAuthLoginFlow ??
              defaultTelegramNativeCommandDeps.runModelsAuthLoginFlow;
            if (!loginFlow) {
              throw new Error("Codex login flow is unavailable.");
            }
            const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
            const targetSessionKey = resolveCommandTargetSessionKey({
              runtimeCfg,
              route,
              chatId,
              isGroup,
              senderId,
              threadSpec,
              botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
              resolveThreadSessionKeys: nativeCommandRuntime.resolveThreadSessionKeys,
            });
            const targetSessionEntry = nativeCommandRuntime.getSessionEntry({
              agentId: route.agentId,
              sessionKey: targetSessionKey,
            });
            const loginResult = await codexChannelLoginRuntime.runDeviceLoginFlow({
              runLoginFlow: loginFlow,
              provider: loginProvider,
              agentId: route.agentId,
              config: runtimeCfg,
              runtime,
              sendMessage: sendLoginMessage,
              unsupportedPromptMessage:
                "Telegram /login supports only fixed Codex device-code auth.",
            });
            const nextProfileId = loginResult.profiles.find(
              (profile) => profile.provider === loginProvider,
            )?.profileId;
            if (!nextProfileId) {
              await sendLoginMessage(
                "Codex login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
              );
              return;
            }
            const needsSessionUpdate =
              targetSessionEntry &&
              (targetSessionEntry.authProfileOverride !== nextProfileId ||
                targetSessionEntry.authProfileOverrideSource !== "user" ||
                targetSessionEntry.authProfileOverrideCompactionCount !== undefined);
            if (targetSessionEntry) {
              try {
                const storePath = resolveStorePath(runtimeCfg.session?.store, {
                  agentId: route.agentId,
                });
                let snapshotMatched = false;
                const persisted = await updateSessionStoreEntry({
                  sessionKey: targetSessionKey,
                  storePath,
                  requireWriteSuccess: true,
                  skipMaintenance: true,
                  update: (entry) => {
                    if (
                      entry.sessionId !== targetSessionEntry.sessionId ||
                      entry.authProfileOverride !== targetSessionEntry.authProfileOverride ||
                      entry.authProfileOverrideSource !==
                        targetSessionEntry.authProfileOverrideSource ||
                      entry.authProfileOverrideCompactionCount !==
                        targetSessionEntry.authProfileOverrideCompactionCount
                    ) {
                      return null;
                    }
                    snapshotMatched = true;
                    return needsSessionUpdate
                      ? {
                          authProfileOverride: nextProfileId,
                          authProfileOverrideSource: "user",
                          authProfileOverrideCompactionCount: undefined,
                        }
                      : null;
                  },
                });
                if (
                  !snapshotMatched ||
                  !persisted ||
                  persisted.authProfileOverride !== nextProfileId ||
                  persisted.authProfileOverrideSource !== "user" ||
                  persisted.authProfileOverrideCompactionCount !== undefined
                ) {
                  await sendLoginMessage(
                    "Codex login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
                  );
                  return;
                }
              } catch (error) {
                runtime.error?.(
                  danger(
                    `telegram /login codex completed but failed to update session auth profile: ${String(
                      error,
                    )}`,
                  ),
                );
                await sendLoginMessage(
                  "Codex login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
                );
                return;
              }
            }
            await sendLoginMessage("Codex login complete. Try your request again now.");
          } catch {
            runtime.error?.(danger("telegram /login codex failed"));
            await sendLoginMessage(
              "Codex login did not complete. Send `/login codex` to request a new code.",
            );
          } finally {
            codexChannelLoginRuntime.releaseFlow({
              flows: activeTelegramCodexLoginFlows,
              flowKey,
              record: reservation.record,
            });
          }
          return;
        }

        let cachedTargetSessionKey: string | undefined;
        let cachedNativeCommandRuntime:
          | Awaited<ReturnType<typeof loadTelegramNativeCommandRuntime>>
          | undefined;
        const resolveNativeCommandRuntime = async () => {
          cachedNativeCommandRuntime ??= await loadTelegramNativeCommandRuntime();
          return cachedNativeCommandRuntime;
        };
        const resolveTargetSessionKey = async (): Promise<string> => {
          if (cachedTargetSessionKey) {
            return cachedTargetSessionKey;
          }
          cachedTargetSessionKey = resolveCommandTargetSessionKey({
            runtimeCfg,
            route,
            chatId,
            isGroup,
            senderId,
            threadSpec,
            botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
            resolveThreadSessionKeys: (await resolveNativeCommandRuntime())
              .resolveThreadSessionKeys,
          });
          return cachedTargetSessionKey;
        };
        const menuNeedsModelContext =
          commandDefinition?.argsMenu &&
          !(commandArgs?.raw && !commandArgs.values) &&
          commandDefinition.args?.some(
            (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
          );
        const targetSessionKeyForMenu =
          commandDefinition && menuNeedsModelContext ? await resolveTargetSessionKey() : "";
        const fastCommandState =
          commandDefinition?.key === "fast" && menuNeedsModelContext
            ? resolveTelegramFastCommandState({
                cfg: runtimeCfg,
                agentId: route.agentId,
                sessionKey: targetSessionKeyForMenu,
              })
            : undefined;
        const fastMenuModelContext =
          commandDefinition?.key === "fast" && menuNeedsModelContext
            ? resolveTelegramFastCommandModelContext({
                cfg: runtimeCfg,
                agentId: route.agentId,
                sessionKey: targetSessionKeyForMenu,
              })
            : undefined;
        const menuModelContext =
          commandDefinition && menuNeedsModelContext
            ? (fastMenuModelContext ??
              resolveTelegramCommandMenuModelContext({
                cfg: runtimeCfg,
                agentId: route.agentId,
                sessionKey: targetSessionKeyForMenu,
              }))
            : {};
        // Native /think must not wait on provider discovery; persisted rows retain its metadata.
        const menuModelCatalog =
          commandDefinition?.key === "think" && menuNeedsModelContext
            ? await loadModelCatalog({ config: runtimeCfg, readOnly: true })
            : undefined;
        const menu = commandDefinition
          ? resolveCommandArgMenu({
              command: commandDefinition,
              args: commandArgs,
              cfg: runtimeCfg,
              ...menuModelContext,
              ...(menuModelCatalog?.length ? { catalog: menuModelCatalog } : {}),
            })
          : null;
        if (menu && commandDefinition) {
          const title = formatTelegramCommandArgMenuTitle({
            command: commandDefinition,
            menu,
            currentThinkingLevel:
              commandDefinition.key === "think"
                ? await resolveTelegramThinkMenuCurrentLevel({
                    cfg: runtimeCfg,
                    agentId: route.agentId,
                    ...menuModelContext,
                    catalog: menuModelCatalog ?? [],
                  })
                : undefined,
            currentFastModeStatus:
              commandDefinition.key === "fast"
                ? resolveTelegramFastMenuCurrentStatus({
                    state:
                      fastCommandState ??
                      resolveTelegramFastCommandState({
                        cfg: runtimeCfg,
                        agentId: route.agentId,
                        sessionKey: targetSessionKeyForMenu,
                      }),
                  })
                : undefined,
          });
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
        const nativeCommandRuntime = await resolveNativeCommandRuntime();
        const sessionKey = await resolveTargetSessionKey();
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
          cfg: runtimeCfg,
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: commandSessionKey,
          policySessionKey: commandTargetSessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          replyToMode: turnSettings.replyToMode,
          textLimit: turnSettings.textLimit,
          linkPreview: runtimeTelegramCfg.linkPreview,
          richMessages: runtimeTelegramCfg.richMessages,
        });
        let topicName: string | undefined;
        if (isForum && resolvedThreadId != null) {
          try {
            const storePath = resolveStorePath(runtimeCfg.session?.store, {
              agentId: route.accountId,
            });
            const scope = resolveTopicNameCacheScope(storePath);
            topicName = await getTopicName(chatId, resolvedThreadId, scope);
          } catch {
            // best-effort: topic name is supplementary metadata
          }
        }
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
          CommandTurn: {
            kind: "native" as const,
            source: "native" as const,
            authorized: commandAuthorized,
            body: prompt,
          },
          CommandSource: "native" as const,
          SessionKey: commandSessionKey,
          AccountId: route.accountId,
          CommandTargetSessionKey: commandTargetSessionKey,
          MessageThreadId: threadSpec.id,
          IsForum: isForum,
          TopicName: isForum && topicName ? topicName : undefined,
          // Originating context for sub-agent announce routing
          OriginatingChannel: "telegram" as const,
          OriginatingTo: originatingTo,
        });
        await nativeCommandRuntime.recordInboundSessionMetaSafe({
          cfg: runtimeCfg,
          agentId: route.agentId,
          sessionKey: commandTargetSessionKey,
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

        const { createChannelMessageReplyPipeline, deliverReplies } =
          await loadTelegramNativeCommandDeliveryRuntime();
        const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
          cfg: runtimeCfg,
          agentId: route.agentId,
          channel: "telegram",
          accountId: route.accountId,
        });

        await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: runtimeCfg,
          dispatcherOptions: {
            ...replyPipeline,
            beforeDeliver: async (payload) => payload,
            deliver: async (payload, _info) => {
              if (
                shouldSuppressLocalTelegramExecApprovalPrompt({
                  cfg: runtimeCfg,
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
        const turnSettings = resolveTelegramMessageTurnSettings({
          accountId,
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          opts,
        });
        const { threadParams } = await resolveTelegramNativeCommandThreadContext({ msg, bot });
        const rawText = ctx.match?.trim() ?? "";
        const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
        const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
        const match = nativeCommandRuntime.matchPluginCommand(commandBody);
        if (!match) {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () => bot.api.sendMessage(chatId, "Command not found.", threadParams ?? {}),
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
          allowFrom: turnSettings.allowFrom,
          groupAllowFrom: turnSettings.groupAllowFrom,
          resolveGroupPolicy,
          resolveTelegramGroupConfig,
          requireAuth: match.command.requireAuth !== false,
        });
        if (!auth) {
          return;
        }
        const { senderId, commandAuthorized, senderIsOwner, isGroup, isForum, resolvedThreadId } =
          auth;
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
        const targetSessionKey = resolveCommandTargetSessionKey({
          runtimeCfg,
          route,
          chatId,
          isGroup,
          senderId,
          threadSpec,
          botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
          resolveThreadSessionKeys: nativeCommandRuntime.resolveThreadSessionKeys,
        });
        const targetSessionEntry = nativeCommandRuntime.getSessionEntry({
          agentId: route.agentId,
          sessionKey: targetSessionKey,
        });
        const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
          cfg: runtimeCfg,
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: targetSessionKey,
          policySessionKey: targetSessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          replyToMode: turnSettings.replyToMode,
          textLimit: turnSettings.textLimit,
          linkPreview: runtimeTelegramCfg.linkPreview,
          richMessages: runtimeTelegramCfg.richMessages,
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

        const transcriptContext = await resolveTelegramCommandTranscriptContext({
          cfg: runtimeCfg,
          agentId: route.agentId,
          sessionKey: targetSessionKey,
          threadId: threadSpec.id,
        });

        const result = normalizeTelegramNativeReplyPayload(
          await nativeCommandRuntime.executePluginCommand({
            command: match.command,
            args: match.args,
            senderId,
            channel: "telegram",
            isAuthorizedSender: commandAuthorized,
            senderIsOwner,
            agentId: route.agentId,
            sessionKey: targetSessionKey,
            sessionId: transcriptContext.sessionId,
            sessionFile: transcriptContext.sessionFile,
            authProfileId:
              transcriptContext.authProfileId ?? targetSessionEntry?.authProfileOverride,
            commandBody,
            config: runtimeCfg,
            from,
            to,
            accountId,
            messageThreadId: threadSpec.id,
          }),
        );

        const suppressTelegramNativeReply =
          shouldSuppressLocalTelegramExecApprovalPrompt({
            cfg: runtimeCfg,
            accountId: route.accountId,
            payload: result,
          }) || isSuppressedTelegramNativeReplyPayload(result);
        if (suppressTelegramNativeReply) {
          await cleanupTelegramProgressPlaceholder({
            bot,
            chatId,
            progressMessageId,
            runtime,
          });
          return;
        }

        const hasReaction = hasTelegramNativeReplyReaction(result);
        const deliverableResult: TelegramNativeReplyPayload =
          hasRenderableTelegramNativeReplyPayload(result)
            ? hasReaction && !normalizeOptionalString(result.replyToId)
              ? { ...result, replyToId: String(msg.message_id) }
              : result
            : { text: EMPTY_RESPONSE_FALLBACK };
        const progressResultText =
          typeof deliverableResult.text === "string" && deliverableResult.text.trim().length > 0
            ? deliverableResult.text
            : null;
        const telegramResultData = resolveTelegramNativeReplyChannelData(deliverableResult);
        if (
          progressMessageId != null &&
          telegramDeps.editMessageTelegram &&
          progressResultText &&
          isEditableTelegramProgressResult(deliverableResult)
        ) {
          try {
            await telegramDeps.editMessageTelegram(chatId, progressMessageId, progressResultText, {
              cfg: runtimeCfg,
              accountId: route.accountId,
              textMode: "markdown",
              linkPreview: runtimeTelegramCfg.linkPreview,
              buttons: telegramResultData?.buttons,
            });
            recordSentMessage(chatId, progressMessageId, runtimeCfg);
            emitTelegramMessageSentHooks({
              sessionKeyForInternalHooks: targetSessionKey,
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
          replies: [deliverableResult],
          ...deliveryBaseOptions,
          ...(hasReaction ? { replyToMode: "all" as const } : {}),
          silent:
            runtimeTelegramCfg.silentErrorReplies === true && deliverableResult.isError === true,
        });
      });
    }
  } else if (nativeDisabledExplicit) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
    withTelegramApiErrorLogging({
      operation: "setMyCommands(all_group_chats)",
      runtime,
      fn: () => bot.api.setMyCommands([], { scope: { type: "all_group_chats" } }),
    }).catch(() => {});
  }
};
