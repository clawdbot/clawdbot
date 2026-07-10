// Telegram plugin module implements bot core behavior.
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage, formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.runtime.js";
import {
  createTelegramMessageProcessor,
  resolveTelegramMessageTurnSettings,
} from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
  TelegramSpooledReplayProcessingError,
} from "./bot-processing-outcome.js";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import { resolveDefaultAgentId } from "./bot.agent.runtime.js";
import { apiThrottler, Bot, sequentialize, type ApiClientOptions } from "./bot.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import { setTelegramCallbackQueryAnswerPromise } from "./callback-query-answer-state.js";
import {
  asTelegramClientFetch,
  createTelegramClientFetch,
  resolveTelegramClientTimeoutMinimumSeconds,
  resolveTelegramClientTimeoutSeconds,
  resolveTelegramOutboundClientTimeoutFloorSeconds,
} from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import {
  buildTelegramSelfSenderName,
  recordTelegramGroupHistoryEntry,
} from "./group-history-window.js";
import { registerTelegramOutboundGroupHistoryRecorder } from "./outbound-message-context.js";
import { formatTelegramRawUpdateForLog } from "./raw-update-log.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey };
export { resolveTelegramScopedGroupConfig };

type TelegramBotRuntime = {
  Bot: typeof Bot;
  sequentialize: typeof sequentialize;
  apiThrottler: typeof apiThrottler;
};
type TelegramBotInstance = InstanceType<TelegramBotRuntime["Bot"]>;

const DEFAULT_TELEGRAM_BOT_RUNTIME: TelegramBotRuntime = {
  Bot,
  sequentialize,
  apiThrottler,
};
const TELEGRAM_TYPING_COALESCE_MS = 4_000;

let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}

export function createTelegramBotCore(
  opts: TelegramBotOptions & { telegramDeps: TelegramBotDeps },
): TelegramBotInstance {
  const botRuntime = telegramBotRuntimeForTest ?? DEFAULT_TELEGRAM_BOT_RUNTIME;
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const telegramDeps = opts.telegramDeps;
  const cfg = opts.config ?? telegramDeps.getRuntimeConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  const threadBindingManager = threadBindingPolicy.enabled
    ? createTelegramThreadBindingManager({
        cfg,
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
      })
    : null;
  const telegramCfg = account.config;

  const telegramTransport =
    opts.telegramTransport ??
    resolveTelegramTransport(opts.proxyFetch, {
      network: telegramCfg.network,
    });
  const finalFetch = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(telegramTransport.fetch),
    timeoutSeconds: telegramCfg?.timeoutSeconds,
    shutdownSignal: opts.fetchAbortSignal,
    transport: telegramTransport,
  });

  const timeoutSeconds = resolveTelegramClientTimeoutSeconds({
    value: telegramCfg?.timeoutSeconds,
    minimum: resolveTelegramClientTimeoutMinimumSeconds([
      opts.minimumClientTimeoutSeconds,
      resolveTelegramOutboundClientTimeoutFloorSeconds(telegramCfg?.timeoutSeconds),
    ]),
  });
  const apiRoot = normalizeOptionalString(telegramCfg.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;
  const client: ApiClientOptions | undefined =
    finalFetch || timeoutSeconds || normalizedApiRoot
      ? {
          ...(finalFetch ? { fetch: asTelegramClientFetch(finalFetch) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
        }
      : undefined;

  const botConfig =
    client || opts.botInfo
      ? { ...(client ? { client } : {}), ...(opts.botInfo ? { botInfo: opts.botInfo } : {}) }
      : undefined;
  const bot = new botRuntime.Bot(opts.token, botConfig);
  bot.api.config.use(getOrCreateAccountThrottler(opts.token, botRuntime.apiThrottler));
  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
  const logSkippedUpdate = (key: string) => {
    if (shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
  };
  const updateTracker = createTelegramUpdateTracker({
    initialUpdateId,
    persistenceFloorUpdateId:
      typeof opts.updateOffset?.persistenceFloorUpdateId === "number"
        ? opts.updateOffset.persistenceFloorUpdateId
        : initialUpdateId,
    ackPolicy: "after_agent_dispatch",
    ...(typeof opts.updateOffset?.onUpdateId === "function"
      ? { onAcceptedUpdateId: opts.updateOffset.onUpdateId }
      : {}),
    onPersistError: (err) => {
      runtime.error?.(`telegram: failed to persist update watermark: ${formatErrorMessage(err)}`);
    },
    onSkip: logSkippedUpdate,
  });
  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) =>
    updateTracker.shouldSkipHandlerDispatch(ctx);

  bot.use(async (ctx, next) => {
    const begin = updateTracker.beginUpdate(ctx);
    if (!begin.accepted) {
      return;
    }
    try {
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        await next();
      });
      const deferredWork = getTelegramSpooledReplayDeferredParticipant();
      if (deferredWork) {
        void deferredWork.task
          .then((deferredResult) => {
            updateTracker.finishUpdate(begin.update, {
              completed: deferredResult.kind !== "failed-retryable",
            });
          })
          .catch(() => {
            updateTracker.finishUpdate(begin.update, { completed: false });
          });
        return;
      }
      if (result?.kind === "failed-retryable") {
        if (isTelegramSpooledReplayUpdate(ctx.update)) {
          throw new TelegramSpooledReplayProcessingError(result.error);
        }
        updateTracker.finishUpdate(begin.update, { completed: true });
        return;
      }
      updateTracker.finishUpdate(begin.update, { completed: true });
    } catch (error) {
      updateTracker.finishUpdate(begin.update, { completed: false });
      throw error;
    }
  });

  // Answer callback queries immediately before sequentialize queues them behind
  // agent turns for the same chat/topic. Telegram has a ~15s server-side timeout
  // for answerCallbackQuery; if an agent turn is already processing, sequentialize
  // delays the answer beyond that window and the user sees a stuck loading spinner.
  bot.use(async (ctx, next) => {
    const callback = ctx.callbackQuery;
    if (callback) {
      const answerPromise = bot.api.answerCallbackQuery(callback.id);
      setTelegramCallbackQueryAnswerPromise(ctx, answerPromise);
      void answerPromise.catch(() => {});
    }
    await next();
  });

  bot.use(botRuntime.sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        rawUpdateLogger.debug(`telegram update: ${formatTelegramRawUpdateForLog(ctx.update)}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

  const { historyLimit } = resolveTelegramMessageTurnSettings({
    accountId: account.accountId,
    cfg,
    telegramCfg,
    opts,
  });
  const groupHistories = new Map<string, HistoryEntry[]>();
  const botHistorySender = buildTelegramSelfSenderName(account.name, opts.botInfo);
  const unregisterOutboundGroupHistoryRecorder = registerTelegramOutboundGroupHistoryRecorder({
    accountId: account.accountId,
    recorder: (record) => {
      if (!String(record.chatId).startsWith("-")) {
        return;
      }
      recordTelegramGroupHistoryEntry({
        historyMap: groupHistories,
        historyKey: buildTelegramGroupPeerId(record.chatId, record.messageThreadId),
        limit: historyLimit,
        entry: {
          sender: botHistorySender,
          body: record.text?.trim() || "<media>",
          timestamp: record.timestamp,
          messageId: String(record.messageId),
        },
      });
    },
  });
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const resolveGroupPolicy = (chatId: string | number, turnCfg: OpenClawConfig) =>
    resolveChannelGroupPolicy({
      cfg: turnCfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
    cfg: OpenClawConfig;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId });
    try {
      const getSessionEntry = telegramDeps.getSessionEntry;
      if (!getSessionEntry) {
        return undefined;
      }
      const entry = getSessionEntry({ storePath, sessionKey });
      if (entry?.groupActivation === "always") {
        return false;
      }
      if (entry?.groupActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number, turnCfg: OpenClawConfig) =>
    resolveChannelGroupRequireMention({
      cfg: turnCfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveTelegramGroupConfig = (
    chatId: string | number,
    messageThreadId: number | undefined,
    turnCfg: OpenClawConfig,
  ) => {
    const turnTelegramCfg = resolveTelegramAccount({
      cfg: turnCfg,
      accountId: account.accountId,
    }).config;
    return resolveTelegramScopedGroupConfig(turnTelegramCfg, chatId, messageThreadId);
  };

  // Global sendChatAction handler with 401 backoff and transient cooldown.
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(chatId, action, threadParams),
    logger: (message) => logVerbose(`telegram: ${message}`),
    minIntervalMs: TELEGRAM_TYPING_COALESCE_MS,
  });

  const processMessage = createTelegramMessageProcessor({
    bot,
    account,
    groupHistories,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    sendChatActionHandler,
    runtime,
    opts,
    telegramDeps,
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    telegramCfg,
    mediaMaxBytes,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts,
    telegramDeps,
  });

  registerTelegramHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    telegramTransport,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    resolveGroupPolicy,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
    telegramDeps,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    unregisterOutboundGroupHistoryRecorder();
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
