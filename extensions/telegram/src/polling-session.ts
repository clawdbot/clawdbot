import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatDurationPrecise, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import type { TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";
import {
  createTelegramRestartBackoffState,
  resetTelegramRestartBackoffState,
  resolveTelegramRestartDelayMs,
} from "./polling-session-restart-policy.js";
import { createTelegramPollingStatusPublisher } from "./polling-status.js";
import { TelegramPollingTransportState } from "./polling-transport-state.js";
import { TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { resolveTelegramAdoptionStallTimeoutMs } from "./telegram-ingress-drain.js";
import {
  resolveTelegramIngressSpoolDir,
  resolveTelegramUpdateId,
} from "./telegram-ingress-spool.js";
import {
  createTelegramIngressWorker,
  type TelegramIngressWorkerFactory,
} from "./telegram-ingress-worker.js";

// Surfaced in logs and channel status when getUpdates returns 409; the only
// user-fixable causes are a second poller on the same token or a stale webhook.
const TELEGRAM_GET_UPDATES_CONFLICT_HINT =
  " Another OpenClaw gateway, script, or Telegram poller may be using this bot token; stop the duplicate poller or switch this account to webhook mode.";

const DEFAULT_POLL_STALL_THRESHOLD_MS = 120_000;
const MIN_POLL_STALL_THRESHOLD_MS = 30_000;
const TELEGRAM_DELIVERY_DRAIN_INTERVAL_MS = 5_000;
const MAX_POLL_STALL_THRESHOLD_MS = 600_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;
// Status-only backlog note threshold (unrelated to adoption timeout).
const TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS = Math.ceil(
  TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1000,
);

function normalizeTelegramAccountId(accountId?: string | null): string {
  return accountId?.trim() || "default";
}

type TelegramBot = ReturnType<typeof createTelegramBot>;

const waitForGracefulStop = async (stop: () => Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const resolvePollingStallThresholdMs = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POLL_STALL_THRESHOLD_MS;
  }
  return Math.min(
    MAX_POLL_STALL_THRESHOLD_MS,
    Math.max(MIN_POLL_STALL_THRESHOLD_MS, Math.floor(value)),
  );
};

type TelegramPollingSessionOpts = {
  token: string;
  config: NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
  accountId: string;
  ownerAgentId?: string;
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  buildContext?: Parameters<typeof createTelegramBot>[0]["buildContext"];
  dispatchReplyFromConfig?: Parameters<typeof createTelegramBot>[0]["dispatchReplyFromConfig"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  botInfo?: Parameters<typeof createTelegramBot>[0]["botInfo"];
  abortSignal?: AbortSignal;
  getCommittedUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => void | Promise<void>;
  log: (line: string) => void;
  /** Pre-resolved Telegram transport to reuse across bot instances */
  telegramTransport?: TelegramTransport;
  /** Rebuild Telegram transport after stall/network recovery when marked dirty. */
  createTelegramTransport?: () => TelegramTransport;
  /** Stall detection threshold in ms. Defaults to 120_000 (2 min). */
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  ingress: {
    apiRoot?: string;
    timeoutSeconds?: number;
    proxy?: string;
    network?: TelegramNetworkConfig;
    spoolDir?: string;
    createWorker?: TelegramIngressWorkerFactory;
    drainIntervalMs?: number;
    spooledUpdateHandlerTimeoutMs?: number;
  };
};

export class TelegramPollingSession {
  #restartBackoffState = createTelegramRestartBackoffState();
  #webhookCleared = false;
  #activeCycleAbort: AbortController | undefined;
  #transportState: TelegramPollingTransportState;
  #status: ReturnType<typeof createTelegramPollingStatusPublisher>;
  #stallThresholdMs: number;
  #spooledUpdateHandlerTimeoutMs: number;
  #deliveryDrainInFlight = false;
  #nextDeliveryDrainAt = 0;

  constructor(private readonly opts: TelegramPollingSessionOpts) {
    this.#transportState = new TelegramPollingTransportState({
      log: opts.log,
      initialTransport: opts.telegramTransport,
      createTelegramTransport: opts.createTelegramTransport,
    });
    this.#status = createTelegramPollingStatusPublisher(opts.setStatus);
    this.#stallThresholdMs = resolvePollingStallThresholdMs(opts.stallThresholdMs);
    this.#spooledUpdateHandlerTimeoutMs = resolveTelegramAdoptionStallTimeoutMs({
      ...(opts.ingress.spooledUpdateHandlerTimeoutMs !== undefined
        ? { configured: opts.ingress.spooledUpdateHandlerTimeoutMs }
        : {}),
      env: process.env,
    });
  }

  async runUntilAbort(): Promise<void> {
    this.#status.notePollingStart();
    try {
      while (!this.opts.abortSignal?.aborted) {
        const bot = await this.#createPollingBot();
        if (!bot) {
          continue;
        }

        const cleanupState = await this.#ensureWebhookCleanup(bot);
        if (cleanupState === "retry") {
          continue;
        }
        if (cleanupState === "exit") {
          return;
        }

        const state = await this.#runPollingCycle(bot);
        if (state === "exit") {
          return;
        }
      }
    } finally {
      // Release the transport's dispatchers on session shutdown. Without
      // this, the undici keep-alive sockets survive beyond the session and
      // leak to api.telegram.org; see openclaw#68128.
      await this.#transportState.dispose();
      this.#status.notePollingStop();
    }
  }

  #noteHealthyPollingCycle() {
    resetTelegramRestartBackoffState(this.#restartBackoffState);
  }

  async #waitBeforeRestart(
    buildLine: (delay: string) => string,
    opts: { stopTimedOut?: boolean } = {},
  ): Promise<boolean> {
    const { delayMs, stopTimeoutSuffix } = resolveTelegramRestartDelayMs(
      this.#restartBackoffState,
      opts,
    );
    const delay = formatDurationPrecise(delayMs);
    this.opts.log(`${buildLine(delay)}${stopTimeoutSuffix}`);
    this.#status.notePollingRecovery();
    try {
      await sleepWithAbort(delayMs, this.opts.abortSignal);
    } catch (sleepErr) {
      if (this.opts.abortSignal?.aborted) {
        return false;
      }
      throw sleepErr;
    }
    return true;
  }

  async #waitBeforeRetryOnRecoverableSetupError(err: unknown, logPrefix: string): Promise<boolean> {
    if (this.opts.abortSignal?.aborted) {
      return false;
    }
    if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
      throw err;
    }
    return this.#waitBeforeRestart(
      (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
    );
  }

  #drainPendingDeliveriesAfterReconnect() {
    if (this.#deliveryDrainInFlight) {
      return;
    }
    if (!this.opts.config) {
      return;
    }
    this.#deliveryDrainInFlight = true;
    const accountId = normalizeTelegramAccountId(this.opts.accountId);
    const cfg = this.opts.config;
    void drainPendingDeliveries({
      drainKey: `telegram:${accountId}`,
      logLabel: "Telegram reconnect drain",
      cfg,
      log: {
        info: (message) => this.opts.log(`[telegram][diag] ${message}`),
        warn: (message) => this.opts.log(`[telegram] ${message}`),
        error: (message) => this.opts.log(`[telegram] ${message}`),
      },
      selectEntry: (entry) => ({
        match:
          entry.channel === "telegram" && normalizeTelegramAccountId(entry.accountId) === accountId,
        bypassBackoff: false,
      }),
    })
      .catch((err: unknown) => {
        this.opts.log(`[telegram] reconnect delivery drain failed: ${formatErrorMessage(err)}`);
      })
      .finally(() => {
        this.#deliveryDrainInFlight = false;
      });
  }

  #maybeDrainPendingDeliveries(finishedAt: number) {
    if (finishedAt < this.#nextDeliveryDrainAt) {
      return;
    }
    // Match the queue's first retry window. This keeps healthy polling useful
    // as a recovery driver without reopening the drain on every long poll.
    this.#nextDeliveryDrainAt = finishedAt + TELEGRAM_DELIVERY_DRAIN_INTERVAL_MS;
    this.#drainPendingDeliveriesAfterReconnect();
  }

  #rearmPendingDeliveryDrain() {
    this.#nextDeliveryDrainAt = 0;
  }

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const cycleAbortController = new AbortController();
    this.#activeCycleAbort = cycleAbortController;
    const cycleAbortSignal = this.opts.abortSignal
      ? AbortSignal.any([this.opts.abortSignal, cycleAbortController.signal])
      : cycleAbortController.signal;
    // Isolated turns can outlive their polling worker after adoption. Keep their
    // Bot API client session-owned while media remains cycle-owned and retryable.
    const telegramTransport = this.#transportState.acquireForNextCycle();
    const committedUpdateId = this.opts.getCommittedUpdateId();
    const updateOffset = {
      lastUpdateId: null,
      persistenceFloorUpdateId: committedUpdateId,
    };
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        buildContext: this.opts.buildContext,
        dispatchReplyFromConfig: this.opts.dispatchReplyFromConfig,
        proxyFetch: this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        ownerAgentId: this.opts.ownerAgentId,
        botInfo: this.opts.botInfo,
        ...(this.opts.abortSignal ? { fetchAbortSignal: this.opts.abortSignal } : {}),
        ...(this.opts.abortSignal ? { accountAbortSignal: this.opts.abortSignal } : {}),
        mediaAbortSignal: cycleAbortSignal,
        minimumClientTimeoutSeconds: TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS,
        updateOffset,
        telegramTransport,
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeCycleAbort === cycleAbortController) {
        this.#activeCycleAbort = undefined;
      }
      return undefined;
    }
  }

  async #ensureWebhookCleanup(bot: TelegramBot): Promise<"ready" | "retry" | "exit"> {
    if (this.#webhookCleared) {
      return "ready";
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "deleteWebhook",
        runtime: this.opts.runtime,
        fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
      });
      this.#webhookCleared = true;
      return "ready";
    } catch (err) {
      if (isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
        this.opts.log(
          `[telegram] deleteWebhook failed with a recoverable network error; continuing to polling so getUpdates can confirm webhook state: ${formatErrorMessage(err)}`,
        );
        return "ready";
      }
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram webhook cleanup failed",
      );
      return shouldRetry ? "retry" : "exit";
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    const ingress = this.opts.ingress;
    const cycleAbortController = this.#activeCycleAbort;
    const abortMedia = () => {
      cycleAbortController?.abort();
    };
    try {
      await bot.init();
    } catch (err) {
      abortMedia();
      if (this.#activeCycleAbort === cycleAbortController) {
        this.#activeCycleAbort = undefined;
      }
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram bot init failed",
      );
      return shouldRetry ? "continue" : "exit";
    }
    // A pre-probed or cached bot may already be initialized; admission and replay
    // must share grammY's actual capability snapshot instead of a second source.
    const botInfo = bot.botInfo;
    const spoolDir =
      ingress.spoolDir ?? resolveTelegramIngressSpoolDir({ accountId: this.opts.accountId });
    const drainIntervalMs = Math.max(100, Math.floor(ingress.drainIntervalMs ?? 500));
    const ingressAbortSignal = cycleAbortController
      ? this.opts.abortSignal
        ? AbortSignal.any([cycleAbortController.signal, this.opts.abortSignal])
        : cycleAbortController.signal
      : this.opts.abortSignal;
    const ingressMonitor = createTelegramTransportIngressMonitor({
      spoolDir,
      bot,
      cfg: this.opts.config,
      accountId: this.opts.accountId,
      botInfo,
      adoptionStallTimeoutMs: this.#spooledUpdateHandlerTimeoutMs,
      pollIntervalMs: drainIntervalMs,
      ...(ingressAbortSignal ? { abortSignal: ingressAbortSignal } : {}),
      onLog: (message) => this.opts.log(message),
      onError: (error) =>
        this.opts.log(
          `[telegram][diag] isolated polling spool drain failed: ${formatErrorMessage(error)}`,
        ),
    });
    const workerFactory = ingress.createWorker ?? createTelegramIngressWorker;
    const worker = workerFactory({
      token: this.opts.token,
      accountId: this.opts.accountId,
      initialUpdateId: this.opts.getCommittedUpdateId(),
      spoolDir,
      apiRoot: ingress.apiRoot,
      timeoutSeconds: ingress.timeoutSeconds,
      network: ingress.network,
      proxy: ingress.proxy,
    });
    let stopWorkerPromise: Promise<void> | undefined;
    const stopWorker = () => {
      stopWorkerPromise ??= Promise.resolve(worker.stop())
        .then(() => undefined)
        .catch(() => undefined);
      return stopWorkerPromise;
    };
    // Readiness contract: test/e2e/qa-lab telegram-bot-token-runtime waits for
    // this marker on the injected runtime log; do not demote it to verbose.
    this.opts.log(`[telegram][diag] isolated polling ingress started spool=${spoolDir}`);
    const pollState: {
      startedAt: number | null;
      offset: number | null;
      outcome: string;
      error?: string;
      errorCode: number | null;
    } = {
      startedAt: null,
      offset: null,
      outcome: "not-started",
      errorCode: null,
    };
    const liveness = new TelegramPollingLivenessTracker();
    let restartRequested = false;
    let stalledRestart = false;
    let stopTimedOut = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const endCycle = () => {
      abortMedia();
    };
    const unsubscribe = worker.onMessage((message) => {
      const ackSpooledUpdate = (
        requestId: string,
        result:
          | { ok: true; updateId: number }
          | {
              ok: false;
              message: string;
            },
      ): void => {
        try {
          worker.ackSpooledUpdate?.(requestId, result);
        } catch (err) {
          this.opts.log(
            `[telegram][diag] isolated polling worker ack failed: ${formatErrorMessage(err)}`,
          );
        }
      };
      if (message.type === "poll-start") {
        liveness.noteGetUpdatesStarted({ offset: message.offset }, message.startedAt);
        pollState.startedAt = message.startedAt;
        pollState.offset = message.offset;
        pollState.outcome = "started";
        delete pollState.error;
        pollState.errorCode = null;
        return;
      }
      if (message.type === "poll-success") {
        liveness.noteGetUpdatesSuccessCount(message.count, message.finishedAt);
        liveness.noteGetUpdatesFinished();
        this.#noteHealthyPollingCycle();
        if (!restartRequested) {
          this.#status.notePollSuccess(message.finishedAt);
        }
        this.#maybeDrainPendingDeliveries(message.finishedAt);
        pollState.outcome = `ok:${message.count}`;
        return;
      }
      if (message.type === "poll-error") {
        this.#rearmPendingDeliveryDrain();
        const retryAfterMs =
          message.errorCode === 429 &&
          message.retryAfterMs !== undefined &&
          Number.isFinite(message.retryAfterMs) &&
          message.retryAfterMs > 0
            ? Math.min(message.retryAfterMs, MAX_POLL_STALL_THRESHOLD_MS)
            : undefined;
        liveness.noteGetUpdatesError(new Error(message.message), message.finishedAt, retryAfterMs);
        liveness.noteGetUpdatesFinished();
        pollState.outcome = "error";
        pollState.error = message.message;
        pollState.errorCode = message.errorCode ?? null;
        return;
      }
      if (message.type === "update") {
        const updateIdHint = resolveTelegramUpdateId(message.update) ?? "unknown";
        this.opts.log(
          `[telegram][diag] isolated polling worker update received updateId=${updateIdHint} queued=${message.queued}`,
        );
        // The worker waits for this request's ACK before emitting the next update.
        // The committed spool enqueue is the ACK boundary; offset persistence is
        // monotonic catch-up and must not stall intake during a state-store outage.
        void (async () => {
          const updateId = resolveTelegramUpdateId(message.update);
          if (updateId === null) {
            ackSpooledUpdate(message.requestId, {
              ok: false,
              message: "Telegram update missing numeric update_id.",
            });
            return;
          }
          try {
            await ingressMonitor.admit(message.update);
            this.opts.log(`[telegram][diag] isolated polling update spooled updateId=${updateId}`);
          } catch (err: unknown) {
            this.opts.log(
              `[telegram] isolated polling update spool failed updateId=${updateIdHint}: ${formatErrorMessage(err)}`,
            );
            ackSpooledUpdate(message.requestId, {
              ok: false,
              message: formatErrorMessage(err),
            });
            return;
          }

          const offsetPersistence = this.opts.persistUpdateId(updateId);
          void Promise.resolve(offsetPersistence).catch((err: unknown) => {
            if (!this.opts.abortSignal?.aborted) {
              this.opts.log(
                `[telegram] isolated polling offset persist failed updateId=${updateId}: ${formatErrorMessage(err)}`,
              );
            }
          });
          this.opts.log(`[telegram][diag] isolated polling offset queued updateId=${updateId}`);
          ackSpooledUpdate(message.requestId, { ok: true, updateId });
        })();
        return;
      }
      if (message.type === "spooled") {
        liveness.noteGetUpdatesActivity();
        ingressMonitor.requestDrain();
      }
    });
    const stopOnAbort = () => {
      endCycle();
      void stopWorker();
    };
    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    // Fail closed when the spool stops making progress: keeping any claim live would
    // prevent a healthy process from recovering a wedged drain.
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => undefined);
    };
    const clearForceCycleTimer = () => {
      if (!forceCycleTimer) {
        return;
      }
      clearTimeout(forceCycleTimer);
      forceCycleTimer = undefined;
    };
    const requestStopForRestart = () => {
      if (restartRequested) {
        return;
      }
      restartRequested = true;
      endCycle();
      void stopWorker();
      if (!forceCycleTimer) {
        forceCycleTimer = setTimeout(() => {
          if (this.opts.abortSignal?.aborted) {
            return;
          }
          this.opts.log(
            `[telegram] Isolated polling ingress stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
          );
          stopTimedOut = true;
          forceCycleResolve?.();
        }, POLL_STOP_GRACE_MS);
      }
    };
    ingressMonitor.start();
    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted || restartRequested) {
        return;
      }
      const stall = liveness.detectStall({
        thresholdMs: this.#stallThresholdMs,
      });
      if (!stall) {
        return;
      }
      this.#transportState.markDirty();
      stalledRestart = true;
      this.opts.log(`[telegram] ${stall.message}`);
      this.#status.notePollingError(stall.message, "recovering");
      requestStopForRestart();
    }, POLL_WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();
    try {
      try {
        await Promise.race([worker.task(), forceCyclePromise]);
        clearForceCycleTimer();
        endCycle();
      } catch (err) {
        if (this.opts.abortSignal?.aborted) {
          return "exit";
        }
        endCycle();
        // The worker only issues getUpdates, so a 409 is always a duplicate
        // poller (or stale webhook) conflict. Re-clear the webhook, rotate
        // the transport (#69787), and
        // restart with backoff instead of crashing the whole account.
        const isConflict = pollState.errorCode === 409;
        if (isConflict) {
          this.#webhookCleared = false;
          this.#transportState.markDirty();
        } else if (
          pollState.error &&
          !isRecoverableTelegramNetworkError(new Error(pollState.error), { context: "polling" })
        ) {
          this.#status.notePollingError(
            pollState.error,
            pollState.errorCode === 401 || pollState.errorCode === 404 ? "blocked" : undefined,
          );
          throw new Error(pollState.error, { cause: err });
        }
        const message = isConflict
          ? `Telegram getUpdates conflict: ${pollState.error}.${TELEGRAM_GET_UPDATES_CONFLICT_HINT}`
          : formatErrorMessage(err);
        this.opts.log(`[telegram][diag] isolated polling ingress failed: ${message}`);
        this.#status.notePollingError(message, "recovering");
        clearForceCycleTimer();
        const shouldRestart = await this.#waitBeforeRestart(
          (delay) => `Telegram isolated polling ingress failed; restarting in ${delay}.`,
        );
        return shouldRestart ? "continue" : "exit";
      }
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      if (restartRequested) {
        if (stalledRestart) {
          this.opts.log(
            `[telegram][diag] isolated polling ingress finished reason=polling stall detected ${liveness.formatDiagnosticFields("error")}`,
          );
        }
        const shouldRestart = await this.#waitBeforeRestart(
          (delay) => `Telegram isolated polling ingress restart requested; restarting in ${delay}.`,
          { stopTimedOut },
        );
        return shouldRestart ? "continue" : "exit";
      }
      const errorText = pollState.error ? ` error=${pollState.error}` : "";
      this.opts.log(
        `[telegram][diag] isolated polling ingress stopped outcome=${pollState.outcome} startedAt=${pollState.startedAt ?? "n/a"} offset=${pollState.offset ?? "n/a"}${errorText}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram isolated polling ingress stopped; restarting in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      clearForceCycleTimer();
      unsubscribe();
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      // End media work before waiting for durable handlers so every interrupted claim can retry.
      endCycle();
      await stopWorker();
      await waitForGracefulStop(() => ingressMonitor.stop());
      await waitForGracefulStop(stopBot);
      if (this.#activeCycleAbort === cycleAbortController) {
        this.#activeCycleAbort = undefined;
      }
    }
  }
}
