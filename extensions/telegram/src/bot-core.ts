import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
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
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.runtime.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import { resolveDefaultAgentId } from "./bot.agent.runtime.js";
import { apiThrottler, Bot, sequentialize, type ApiClientOptions } from "./bot.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramTransport } from "./fetch.js";
import { tagTelegramNetworkError } from "./network-errors.js";
import { resolveTelegramRequestTimeoutMs } from "./request-timeouts.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey };

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

let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}

type TelegramFetchInput = Parameters<NonNullable<ApiClientOptions["fetch"]>>[0];
type TelegramFetchInit = Parameters<NonNullable<ApiClientOptions["fetch"]>>[1];
type TelegramClientFetch = NonNullable<ApiClientOptions["fetch"]>;
type TelegramCompatFetch = (
  input: TelegramFetchInput,
  init?: TelegramFetchInit,
) => ReturnType<TelegramClientFetch>;
type TelegramAbortSignalLike = {
  aborted: boolean;
  reason?: unknown;
  addEventListener: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

function asTelegramClientFetch(
  fetchImpl: TelegramCompatFetch | typeof globalThis.fetch,
): TelegramClientFetch {
  return fetchImpl as unknown as TelegramClientFetch;
}

function asTelegramCompatFetch(fetchImpl: TelegramClientFetch): TelegramCompatFetch {
  return fetchImpl as unknown as TelegramCompatFetch;
}

function isTelegramAbortSignalLike(value: unknown): value is TelegramAbortSignalLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function" &&
    typeof (value as { removeEventListener?: unknown }).removeEventListener === "function"
  );
}

function readRequestUrl(input: TelegramFetchInput): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return null;
}

function extractTelegramApiMethod(input: TelegramFetchInput): string | null {
  const url = readRequestUrl(input);
  if (!url) {
    return null;
  }
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const method = segments.length > 0 ? (segments.at(-1) ?? null) : null;
    return normalizeOptionalLowercaseString(method) ?? null;
  } catch {
    return null;
  }
}

const TELEGRAM_TIMEOUT_FALLBACK_METHODS = new Set([
  "deletemycommands",
  "deletewebhook",
  "getme",
  "sendchataction",
  "setmycommands",
  "setwebhook",
]);
function shouldRetryTimedOutTelegramControlRequest(method: string | null): boolean {
  return method !== null && TELEGRAM_TIMEOUT_FALLBACK_METHODS.has(method);
}

function resolveTelegramClientTimeoutSeconds(params: {
  value: unknown;
  minimum?: number;
}): number | undefined {
  const { value, minimum } = params;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const configured = Math.max(1, Math.floor(value));
  if (typeof minimum !== "number" || !Number.isFinite(minimum)) {
    return configured;
  }
  return Math.max(configured, Math.max(1, Math.floor(minimum)));
}

function resolveTelegramClientTimeoutMinimumSeconds(values: readonly (number | undefined)[]) {
  let minimum: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const normalized = Math.max(1, Math.ceil(value));
    minimum = minimum === undefined ? normalized : Math.max(minimum, normalized);
  }
  return minimum;
}

function resolveTelegramOutboundClientTimeoutFloorSeconds(timeoutSeconds: unknown) {
  const timeoutMs = resolveTelegramRequestTimeoutMs("sendmessage", timeoutSeconds);
  return timeoutMs === undefined ? undefined : timeoutMs / 1000;
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
  const shouldProvideFetch = Boolean(telegramTransport.fetch);
  // grammY's ApiClientOptions types still track `node-fetch` types; Node 22+ global fetch
  // (undici) is structurally compatible at runtime but not assignable in TS.
  const fetchForClient = telegramTransport.fetch
    ? asTelegramCompatFetch(asTelegramClientFetch(telegramTransport.fetch))
    : undefined;

  // Wrap fetch so polling requests cannot hang indefinitely on a wedged network path,
  // and so shutdown still aborts in-flight Telegram API requests immediately.
  let finalFetch: TelegramCompatFetch | undefined = shouldProvideFetch ? fetchForClient : undefined;
  if (finalFetch || opts.fetchAbortSignal) {
    const baseFetch = finalFetch ?? asTelegramCompatFetch(asTelegramClientFetch(globalThis.fetch));
    // Cast baseFetch to global fetch to avoid node-fetch ↔ global-fetch type divergence;
    // they are runtime-compatible (the codebase already casts at every fetch boundary).
    const callFetch = baseFetch;
    // Use manual event forwarding instead of AbortSignal.any() to avoid the cross-realm
    // AbortSignal issue in Node.js (grammY's signal may come from a different module context,
    // causing "signals[0] must be an instance of AbortSignal" errors).
    finalFetch = async (input: TelegramFetchInput, init?: TelegramFetchInit) => {
      const method = extractTelegramApiMethod(input);
      const requestTimeoutMs = resolveTelegramRequestTimeoutMs(method, telegramCfg?.timeoutSeconds);
      const shutdownSignal = isTelegramAbortSignalLike(opts.fetchAbortSignal)
        ? opts.fetchAbortSignal
        : undefined;
      const requestSignal = isTelegramAbortSignalLike(init?.signal) ? init.signal : undefined;

      const runFetch = async () => {
        const controller = new AbortController();
        const abortWith = (signal: Pick<TelegramAbortSignalLike, "reason">) =>
          controller.abort(signal.reason);
        const onShutdown = () => {
          if (shutdownSignal) {
            abortWith(shutdownSignal);
          }
        };
        let requestTimeout: ReturnType<typeof setTimeout> | undefined;
        let onRequestAbort: (() => void) | undefined;
        let requestTimedOut = false;
        const timeoutError =
          requestTimeoutMs !== undefined
            ? new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`)
            : undefined;

        if (shutdownSignal?.aborted) {
          abortWith(shutdownSignal);
        } else if (shutdownSignal) {
          shutdownSignal.addEventListener("abort", onShutdown, { once: true });
        }
        if (requestSignal) {
          if (requestSignal.aborted) {
            abortWith(requestSignal);
          } else {
            onRequestAbort = () => abortWith(requestSignal);
            requestSignal.addEventListener("abort", onRequestAbort);
          }
        }
        if (requestTimeoutMs && timeoutError) {
          requestTimeout = setTimeout(() => {
            requestTimedOut = true;
            controller.abort(timeoutError);
          }, requestTimeoutMs);
          requestTimeout.unref?.();
        }
        try {
          return await callFetch(input, {
            ...init,
            signal: controller.signal,
          });
        } catch (err) {
          if (requestTimedOut && timeoutError) {
            throw timeoutError;
          }
          throw err;
        } finally {
          if (requestTimeout) {
            clearTimeout(requestTimeout);
          }
          shutdownSignal?.removeEventListener("abort", onShutdown);
          if (requestSignal && onRequestAbort) {
            requestSignal.removeEventListener("abort", onRequestAbort);
          }
        }
      };

      try {
        return await runFetch();
      } catch (err) {
        if (
          requestTimeoutMs &&
          shouldRetryTimedOutTelegramControlRequest(method) &&
          !shutdownSignal?.aborted &&
          !requestSignal?.aborted &&
          telegramTransport.forceFallback?.("request-timeout")
        ) {
          return await runFetch();
        }
        throw err;
      }
    };
  }
  if (finalFetch) {
    const baseFetch = finalFetch;
    finalFetch = (input: TelegramFetchInput, init?: TelegramFetchInit) => {
      return Promise.resolve(baseFetch(input, init)).catch((err: unknown) => {
        try {
          tagTelegramNetworkError(err, {
            method: extractTelegramApiMethod(input),
            url: readRequestUrl(input),
          });
        } catch {
          // Tagging is best-effort; preserve the original fetch failure if the
          // error object cannot accept extra metadata.
        }
        throw err;
      });
    };
  }

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

  const bot = new botRuntime.Bot(opts.token, client ? { client } : undefined);
  bot.api.config.use(botRuntime.apiThrottler());
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
    let completed = false;
    try {
      await next();
      completed = true;
    } finally {
      updateTracker.finishUpdate(begin.update, { completed });
    }
  });

  bot.use(botRuntime.sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update: unknown) => {
    const seen = new WeakSet();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`,
        ];
      }
      if (value && typeof value === "object") {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  };

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyUpdate(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
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
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    try {
      const loadSessionStore = telegramDeps.loadSessionStore;
      if (!loadSessionStore) {
        return undefined;
      }
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
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
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const loadFreshTelegramAccountConfig = () => {
    try {
      return resolveTelegramAccount({
        cfg: telegramDeps.getRuntimeConfig(),
        accountId: account.accountId,
      }).config;
    } catch (error) {
      logVerbose(
        `telegram: failed to load fresh config for account ${account.accountId}; using startup snapshot: ${String(error)}`,
      );
      return telegramCfg;
    }
  };
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const freshTelegramCfg = loadFreshTelegramAccountConfig();
    const groups = freshTelegramCfg.groups;
    const direct = freshTelegramCfg.direct;
    const chatIdStr = String(chatId);
    const isDm = !chatIdStr.startsWith("-");

    if (isDm) {
      const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
      if (directConfig) {
        const topicConfig =
          messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : undefined;
        return { groupConfig: directConfig, topicConfig };
      }
      // DMs without direct config: don't fall through to groups lookup
      return { groupConfig: undefined, topicConfig: undefined };
    }

    if (!groups) {
      return { groupConfig: undefined, topicConfig: undefined };
    }
    const groupConfig = groups[chatIdStr] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  // Global sendChatAction handler with 401 backoff / circuit breaker (issue #27092).
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(chatId, action, threadParams),
    logger: (message) => logVerbose(`telegram: ${message}`),
  });

  const processMessage = createTelegramMessageProcessor({
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig: () => telegramDeps.getRuntimeConfig(),
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    telegramDeps,
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
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
    allowFrom,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
    telegramDeps,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
