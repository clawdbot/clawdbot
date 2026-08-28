// Telegram plugin module implements monitor behavior.
import type { RunOptions } from "@grammyjs/runner";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveAgentMaxConcurrent } from "openclaw/plugin-sdk/model-session-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
  waitForAbortSignal,
} from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { isTelegramExecApprovalHandlerConfigured } from "./exec-approvals.js";
import { resolveTelegramTransport } from "./fetch.js";
import type { MonitorTelegramOpts } from "./monitor.types.js";
import {
  isRecoverableTelegramNetworkError,
  isTelegramPollingNetworkError,
} from "./network-errors.js";
import { acquireTelegramPollingLease } from "./polling-lease.js";
import { makeProxyFetch } from "./proxy.js";
import {
  createTelegramUpdateOffsetPersistence,
  normalizeTelegramUpdateId,
} from "./update-offset-persistence.js";
import type {
  TelegramOffsetRotationReason,
  TelegramUpdateOffsetRotationInfo,
} from "./update-offset-store.js";

function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Keep grammY retrying for a long outage window. If polling still
      // stops, the outer monitor loop restarts it with backoff.
      maxRetryTime: 60 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_OFFSET_ROTATION_LABELS: Record<TelegramOffsetRotationReason, string> = {
  "bot-id-changed": "bot identity change",
  "legacy-state": "legacy update offset",
  "token-rotated": "token rotation",
};

function formatTelegramOffsetRotationMessage(
  accountId: string,
  info: TelegramUpdateOffsetRotationInfo,
): string {
  const previousLabel = info.previousBotId ?? "(legacy unscoped offset)";
  const reasonLabel = TELEGRAM_OFFSET_ROTATION_LABELS[info.reason];
  return `[telegram] Detected ${reasonLabel} for account "${accountId}" (was ${previousLabel}, now ${info.currentBotId}); discarding stale update offset ${info.staleLastUpdateId} and starting fresh.`;
}

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

type TelegramMonitorPollingRuntime = typeof import("./monitor-polling.runtime.js");
type TelegramPollingSessionInstance = InstanceType<
  TelegramMonitorPollingRuntime["TelegramPollingSession"]
>;

const loadTelegramMonitorPollingRuntime = createLazyRuntimeModule(
  () => import("./monitor-polling.runtime.js"),
);

const loadTelegramMonitorWebhookRuntime = createLazyRuntimeModule(
  () => import("./monitor-webhook.runtime.js"),
);

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const logInfo = (line: string) => (opts.runtime?.log ?? console.log)(line);
  const logError = (line: string) => (opts.runtime?.error ?? console.error)(line);
  const log = (line: string) => {
    if (line.includes("[telegram][diag]")) {
      logInfo(line);
      return;
    }
    logError(line);
  };
  let pollingSession: TelegramPollingSessionInstance | undefined;

  const handlePollingNetworkFailure = (err: unknown, label: string) => {
    const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
    const isTelegramPollingError = isTelegramPollingNetworkError(err);

    const activeRunner = pollingSession?.activeRunner;
    if (isNetworkError && isTelegramPollingError && activeRunner && activeRunner.isRunning()) {
      pollingSession?.markForceRestarted();
      pollingSession?.markTransportDirty();
      pollingSession?.abortActiveFetch();
      void activeRunner.stop().catch(() => {});
      log("[telegram][diag] marking transport dirty after polling network failure");
      log(`[telegram] Restarting polling after ${label}: ${formatErrorMessage(err)}`);
      return true;
    }

    if (isGrammyHttpError(err) && isNetworkError && isTelegramPollingError) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true;
    }

    return false;
  };

  const unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((err) =>
    handlePollingNetworkFailure(err, "unhandled network error"),
  );
  const unregisterUncaughtExceptionHandler = registerUncaughtExceptionHandler((err) =>
    handlePollingNetworkFailure(err, "uncaught network error"),
  );

  try {
    const cfg = opts.config ?? getRuntimeConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const ownerAgentId =
      opts.ownerAgentId?.trim() ||
      resolveTelegramAccountOwnerAgentId({ cfg, accountId: account.accountId });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

    // SAFETY: Gateway startup supplies the full plugin channel runtime; the surface type is the minimal external view.
    const pluginChannelRuntime = opts.channelRuntime as PluginRuntime["channel"] | undefined;

    if (opts.useWebhook) {
      const { startTelegramWebhook } = await loadTelegramMonitorWebhookRuntime();
      if (isTelegramExecApprovalHandlerConfigured({ cfg, accountId: account.accountId })) {
        registerChannelRuntimeContext({
          channelRuntime: opts.channelRuntime,
          channelId: "telegram",
          accountId: account.accountId,
          capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
          context: { token },
          abortSignal: opts.abortSignal,
        });
      }
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        ownerAgentId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret ?? account.config.webhookSecret,
        host: opts.webhookHost ?? account.config.webhookHost,
        runtime: opts.runtime as RuntimeEnv,
        buildContext: pluginChannelRuntime?.inbound.buildContext,
        // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
        dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
        webhookCertPath: opts.webhookCertPath,
        setStatus: opts.setStatus,
      });
      await waitForAbortSignal(opts.abortSignal);
      return;
    }

    const {
      TelegramPollingSession,
      deleteTelegramUpdateOffset,
      readTelegramUpdateOffset,
      writeTelegramUpdateOffset,
    } = await loadTelegramMonitorPollingRuntime();

    const pollingLease = await acquireTelegramPollingLease({
      token,
      accountId: account.accountId,
      abortSignal: opts.abortSignal,
    });
    if (pollingLease.waitedForPrevious) {
      log(
        `[telegram][diag] waited for previous polling session for bot token ${pollingLease.tokenFingerprint} before starting account "${account.accountId}".`,
      );
    }
    if (pollingLease.replacedStoppingPrevious) {
      log(
        `[telegram][diag] previous polling session for bot token ${pollingLease.tokenFingerprint} did not stop within the lease wait; starting a replacement for account "${account.accountId}".`,
      );
    }

    try {
      if (isTelegramExecApprovalHandlerConfigured({ cfg, accountId: account.accountId })) {
        registerChannelRuntimeContext({
          channelRuntime: opts.channelRuntime,
          channelId: "telegram",
          accountId: account.accountId,
          capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
          context: { token },
          abortSignal: opts.abortSignal,
        });
      }

      const persistedOffsetRaw = await readTelegramUpdateOffset({
        accountId: account.accountId,
        botToken: token,
        onRotationDetected: async (info) => {
          log(formatTelegramOffsetRotationMessage(account.accountId, info));
          try {
            await deleteTelegramUpdateOffset({ accountId: account.accountId });
          } catch (err) {
            logError(
              `telegram: failed to delete stale update offset after rotation: ${String(err)}`,
            );
          }
        },
      });
      const lastUpdateId = normalizeTelegramUpdateId(persistedOffsetRaw);
      if (persistedOffsetRaw !== null && lastUpdateId === null) {
        log(
          `[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`,
        );
      }

      const offsetPersistence = createTelegramUpdateOffsetPersistence({
        initialUpdateId: lastUpdateId,
        writeUpdateId: async (updateId) => {
          await writeTelegramUpdateOffset({
            accountId: account.accountId,
            updateId,
            botToken: token,
          });
        },
        onInvalidUpdateId: (updateId) => {
          log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
        },
        onRetry: ({ attempt, delayMs, error, updateId }) => {
          logError(
            `telegram: failed to persist update offset ${updateId}; retry ${attempt} in ${delayMs}ms: ${formatErrorMessage(error)}`,
          );
        },
        abortSignal: opts.abortSignal,
      });

      // Preserve sticky IPv4 fallback state across clean/conflict restarts.
      // Dirty polling cycles rebuild transport inside TelegramPollingSession.
      const createTelegramTransportForPolling = () =>
        resolveTelegramTransport(proxyFetch, {
          network: account.config.network,
        });
      const telegramTransport = createTelegramTransportForPolling();

      pollingSession = new TelegramPollingSession({
        token,
        config: cfg,
        accountId: account.accountId,
        ownerAgentId,
        runtime: opts.runtime,
        buildContext: pluginChannelRuntime?.inbound.buildContext,
        // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
        dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
        proxyFetch,
        botInfo: opts.botInfo,
        abortSignal: opts.abortSignal,
        runnerOptions: createTelegramRunnerOptions(cfg),
        getAcceptedUpdateId: offsetPersistence.getAcceptedUpdateId,
        getCommittedUpdateId: offsetPersistence.getCommittedUpdateId,
        persistUpdateId: offsetPersistence.persistUpdateId,
        log,
        telegramTransport,
        createTelegramTransport: createTelegramTransportForPolling,
        setStatus: opts.setStatus,
        isolatedIngress: {
          enabled: opts.isolatedIngress?.enabled ?? true,
          apiRoot: account.config.apiRoot,
          proxy: account.config.proxy,
          network: account.config.network,
        },
      });
      try {
        await pollingSession.runUntilAbort();
      } finally {
        await offsetPersistence.stop();
      }
    } finally {
      pollingLease.release();
    }
  } finally {
    unregisterUnhandledRejectionHandler();
    unregisterUncaughtExceptionHandler();
  }
}
