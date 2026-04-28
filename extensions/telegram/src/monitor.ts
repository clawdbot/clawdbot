import type { RunOptions } from "@grammyjs/runner";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAgentMaxConcurrent } from "openclaw/plugin-sdk/model-session-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
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

export type { MonitorTelegramOpts } from "./monitor.types.js";

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
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

function normalizePersistedUpdateId(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
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

let telegramMonitorPollingRuntimePromise:
  | Promise<typeof import("./monitor-polling.runtime.js")>
  | undefined;

async function loadTelegramMonitorPollingRuntime() {
  telegramMonitorPollingRuntimePromise ??= import("./monitor-polling.runtime.js");
  return await telegramMonitorPollingRuntimePromise;
}

let telegramMonitorWebhookRuntimePromise:
  | Promise<typeof import("./monitor-webhook.runtime.js")>
  | undefined;

async function loadTelegramMonitorWebhookRuntime() {
  telegramMonitorWebhookRuntimePromise ??= import("./monitor-webhook.runtime.js");
  return await telegramMonitorWebhookRuntimePromise;
}

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;
  let pollingSession: TelegramPollingSessionInstance | undefined;

  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
    const isTelegramPollingError = isTelegramPollingNetworkError(err);
    if (isGrammyHttpError(err) && isNetworkError && isTelegramPollingError) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true;
    }

    const activeRunner = pollingSession?.activeRunner;
    if (isNetworkError && isTelegramPollingError && activeRunner && activeRunner.isRunning()) {
      pollingSession?.markForceRestarted();
      pollingSession?.markTransportDirty();
      pollingSession?.abortActiveFetch();
      void activeRunner.stop().catch(() => {});
      log("[telegram][diag] marking transport dirty after polling network failure");
      log(
        `[telegram] Restarting polling after unhandled network error: ${formatErrorMessage(err)}`,
      );
      return true;
    }

    return false;
  });

  try {
    const cfg = opts.config ?? getRuntimeConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

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
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret ?? account.config.webhookSecret,
        host: opts.webhookHost ?? account.config.webhookHost,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
        webhookCertPath: opts.webhookCertPath,
      });
      await waitForAbortSignal(opts.abortSignal);
      return;
    }

    const { TelegramPollingSession, readTelegramUpdateOffset, writeTelegramUpdateOffset } =
      await loadTelegramMonitorPollingRuntime();

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
      });
      let lastUpdateId = normalizePersistedUpdateId(persistedOffsetRaw);
      if (persistedOffsetRaw !== null && lastUpdateId === null) {
        log(
          `[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`,
        );
      }

      const persistUpdateId = async (updateId: number) => {
        const normalizedUpdateId = normalizePersistedUpdateId(updateId);
        if (normalizedUpdateId === null) {
          log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
          return;
        }
        if (lastUpdateId !== null && normalizedUpdateId <= lastUpdateId) {
          return;
        }
        lastUpdateId = normalizedUpdateId;
        try {
          await writeTelegramUpdateOffset({
            accountId: account.accountId,
            updateId: normalizedUpdateId,
            botToken: token,
          });
        } catch (err) {
          (opts.runtime?.error ?? console.error)(
            `telegram: failed to persist update offset: ${String(err)}`,
          );
        }
      };

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
        runtime: opts.runtime,
        proxyFetch,
        abortSignal: opts.abortSignal,
        runnerOptions: createTelegramRunnerOptions(cfg),
        getLastUpdateId: () => lastUpdateId,
        persistUpdateId,
        log,
        telegramTransport,
        createTelegramTransport: createTelegramTransportForPolling,
        stallThresholdMs: account.config.pollingStallThresholdMs,
        setStatus: opts.setStatus,
      });
      await pollingSession.runUntilAbort();
    } finally {
      pollingLease.release();
    }
  } finally {
    unregisterHandler();
  }
}
