// Telegram plugin module implements polling session behavior.
import { type RunOptions, run } from "@grammyjs/runner";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatDurationPrecise, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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
import { createTelegramTransportIngressDrain } from "./telegram-ingress-drain-factory.js";
import { resolveTelegramAdoptionStallTimeoutMs } from "./telegram-ingress-drain.js";
import {
  resolveTelegramIngressSpoolDir,
  telegramSpooledUpdateLaneKey,
  writeTelegramSpooledUpdate,
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
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  botInfo?: Parameters<typeof createTelegramBot>[0]["botInfo"];
  abortSignal?: AbortSignal;
  runnerOptions: RunOptions<unknown>;
  getLastUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => Promise<void>;
  log: (line: string) => void;
  /** Pre-resolved Telegram transport to reuse across bot instances */
  telegramTransport?: TelegramTransport;
  /** Rebuild Telegram transport after stall/network recovery when marked dirty. */
  createTelegramTransport?: () => TelegramTransport;
  /** Stall detection threshold in ms. Defaults to 120_000 (2 min). */
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  isolatedIngress?: {
    enabled: boolean;
    apiRoot?: string;
    timeoutSeconds?: number;
    proxy?: string;
    network?: TelegramNetworkConfig;
    spoolDir?: string;
    createWorker?: TelegramIngressWorkerFactory;
    drainIntervalMs?: number;
    spooledUpdateHandlerTimeoutMs?: number;
    spooledUpdateHandlerAbortGraceMs?: number;
  };
};

export class TelegramPollingSession {
  #restartBackoffState = createTelegramRestartBackoffState();
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
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
      ...(opts.isolatedIngress?.spooledUpdateHandlerTimeoutMs !== undefined
        ? { configured: opts.isolatedIngress.spooledUpdateHandlerTimeoutMs }
        : {}),
      env: process.env,
    });
  }

  get activeRunner() {
    return this.#activeRunner;
  }

  markForceRestarted() {
    this.#forceRestarted = true;
  }

  markTransportDirty() {
    this.#transportState.markDirty();
  }

  abortActiveFetch() {
    this.#activeCycleAbort?.abort();
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

        const state = this.opts.isolatedIngress?.enabled
          ? await this.#runIsolatedIngressCycle(bot)
          : await this.#runPollingCycle(bot);
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
    const botApiAbortSignal = this.opts.isolatedIngress?.enabled
      ? this.opts.abortSignal
      : cycleAbortSignal;
    const telegramTransport = this.#transportState.acquireForNextCycle();
    const persistedLastUpdateId = this.opts.getLastUpdateId();
    const lastUpdateId = this.opts.isolatedIngress?.enabled ? null : persistedLastUpdateId;
    const updateOffset = {
      lastUpdateId,
      persistenceFloorUpdateId: persistedLastUpdateId,
      onUpdateId: this.opts.persistUpdateId,
    };
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        proxyFetch: this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        botInfo: this.opts.botInfo,
        ...(botApiAbortSignal ? { fetchAbortSignal: botApiAbortSignal } : {}),
        mediaAbortSignal: cycleAbortSignal,
        minimumClientTimeoutSeconds: TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS,
        ...(updateOffset ? { updateOffset } : {}),
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

  #ingressDrain: ReturnType<typeof createTelegramTransportIngressDrain> | undefined;

  /** Long-lived drain for this session; dispose only when the cycle ends. */
  #getOrCreateSpooledDrain(params: {
    bot: TelegramBot;
    spoolDir: string;
  }): ReturnType<typeof createTelegramTransportIngressDrain> {
    if (this.#ingressDrain) {
      return this.#ingressDrain;
    }
    this.#ingressDrain = createTelegramTransportIngressDrain({
      spoolDir: params.spoolDir,
      bot: params.bot,
      cfg: this.opts.config,
      accountId: this.opts.accountId,
      botInfo: this.opts.botInfo,
      adoptionStallTimeoutMs: this.#spooledUpdateHandlerTimeoutMs,
      abortSignal: this.opts.abortSignal,
      onLog: (message) => this.opts.log(message),
    });
    return this.#ingressDrain;
  }

  /** Pump the core-owned durable ingress drain for this session's spool. */
  async #pumpSpooledDrain(params: {
    bot: TelegramBot;
    spoolDir: string;
    shouldStop: () => boolean;
  }): Promise<{ started: number }> {
    if (params.shouldStop()) {
      return { started: 0 };
    }
    const drain = this.#getOrCreateSpooledDrain(params);
    return await drain.drainOnce({ shouldStop: params.shouldStop });
  }

  async #runIsolatedIngressCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    const ingress = this.opts.isolatedIngress;
    if (!ingress?.enabled) {
      return this.#runPollingCycle(bot);
    }
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
    const spoolDir =
      ingress.spoolDir ?? resolveTelegramIngressSpoolDir({ accountId: this.opts.accountId });
    const workerFactory = ingress.createWorker ?? createTelegramIngressWorker;
    const worker = workerFactory({
      token: this.opts.token,
      accountId: this.opts.accountId,
      initialUpdateId: this.opts.getLastUpdateId(),
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
    let consecutiveDrainFailures = 0;
    let restartRequested = false;
    let stalledRestart = false;
    let stopTimedOut = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    let requestImmediateDrain: () => void = () => undefined;
    let drainRequested = false;
    let cycleEnding = false;
    const endCycle = () => {
      cycleEnding = true;
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
        liveness.noteGetUpdatesError(new Error(message.message), message.finishedAt);
        liveness.noteGetUpdatesFinished();
        pollState.outcome = "error";
        pollState.error = message.message;
        pollState.errorCode = message.errorCode ?? null;
        return;
      }
      if (message.type === "update") {
        void writeTelegramSpooledUpdate({
          spoolDir,
          update: message.update,
          laneKey: telegramSpooledUpdateLaneKey(message.update, this.opts.botInfo),
        }).then(
          (updateId) => {
            ackSpooledUpdate(message.requestId, { ok: true, updateId });
            requestImmediateDrain();
          },
          (err: unknown) => {
            ackSpooledUpdate(message.requestId, {
              ok: false,
              message: formatErrorMessage(err),
            });
          },
        );
        return;
      }
      if (message.type === "spooled") {
        liveness.noteGetUpdatesActivity();
        requestImmediateDrain();
      }
    });
    const stopOnAbort = () => {
      endCycle();
      void stopWorker();
    };
    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    const drainIntervalMs = Math.max(100, Math.floor(ingress.drainIntervalMs ?? 500));
    let drainActive = false;
    const drainHealth = { lastCompletedAt: Date.now() };
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
    const drainOnce = async () => {
      if (cycleEnding || restartRequested || this.opts.abortSignal?.aborted) {
        return;
      }
      if (drainActive) {
        drainRequested = true;
        return;
      }
      drainActive = true;
      drainRequested = false;
      let drainCompleted = false;
      try {
        await this.#pumpSpooledDrain({
          bot,
          spoolDir,
          shouldStop: () => cycleEnding,
        });
        consecutiveDrainFailures = 0;
        drainCompleted = true;
      } catch (err) {
        consecutiveDrainFailures += 1;
        this.opts.log(
          `[telegram][diag] isolated polling spool drain failed (${consecutiveDrainFailures}): ${formatErrorMessage(err)}`,
        );
      } finally {
        if (drainCompleted) {
          drainHealth.lastCompletedAt = Date.now();
        }
        drainActive = false;
        if (
          drainRequested &&
          !cycleEnding &&
          !restartRequested &&
          !this.opts.abortSignal?.aborted
        ) {
          drainRequested = false;
          // Handler finalizers clear active lane guards in microtasks; redrain
          // after them so newly unblocked same-lane rows can claim immediately.
          void Promise.resolve().then(drainOnce);
        }
      }
    };
    requestImmediateDrain = () => {
      void drainOnce();
    };
    await drainOnce();
    const drainTimer = setInterval(() => {
      void drainOnce();
    }, drainIntervalMs);
    drainTimer.unref?.();
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
      this.#status.notePollingError(stall.message);
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
        // poller (or stale webhook) conflict. Mirror the classic polling
        // cycle: re-clear the webhook, rotate the transport (#69787), and
        // restart with backoff instead of crashing the whole account.
        const isConflict = pollState.errorCode === 409;
        if (isConflict) {
          this.#webhookCleared = false;
          this.#transportState.markDirty();
        } else if (
          pollState.error &&
          !isRecoverableTelegramNetworkError(new Error(pollState.error), { context: "polling" })
        ) {
          this.#status.notePollingError(pollState.error);
          throw new Error(pollState.error, { cause: err });
        }
        const message = isConflict
          ? `Telegram getUpdates conflict: ${pollState.error}.${TELEGRAM_GET_UPDATES_CONFLICT_HINT}`
          : formatErrorMessage(err);
        this.opts.log(`[telegram][diag] isolated polling ingress failed: ${message}`);
        this.#status.notePollingError(message);
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
      clearInterval(drainTimer);
      clearForceCycleTimer();
      unsubscribe();
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      // End media work before waiting for durable handlers so every interrupted claim can retry.
      endCycle();
      await stopWorker();
      if (!restartRequested) {
        await drainOnce();
      }
      this.#ingressDrain?.dispose();
      this.#ingressDrain = undefined;
      await waitForGracefulStop(stopBot);
      if (this.#activeCycleAbort === cycleAbortController) {
        this.#activeCycleAbort = undefined;
      }
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    const liveness = new TelegramPollingLivenessTracker({
      onPollSuccess: (finishedAt) => {
        this.#noteHealthyPollingCycle();
        this.#status.notePollSuccess(finishedAt);
        this.#maybeDrainPendingDeliveries(finishedAt);
      },
    });
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== "getUpdates") {
        return await prev(method, payload, signal);
      }

      liveness.noteGetUpdatesStarted(payload);
      try {
        const result = await prev(method, payload, signal);
        liveness.noteGetUpdatesSuccess(result);
        return result;
      } catch (err) {
        this.#rearmPendingDeliveryDrain();
        liveness.noteGetUpdatesError(err);
        throw err;
      } finally {
        liveness.noteGetUpdatesFinished();
      }
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.opts.log(`[telegram][diag] polling cycle started ${liveness.formatDiagnosticFields()}`);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeCycleAbort;
    const abortFetch = () => {
      fetchAbortController?.abort();
    };

    if (this.opts.abortSignal && fetchAbortController) {
      this.opts.abortSignal.addEventListener("abort", abortFetch, { once: true });
    }
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const clearForceCycleTimer = () => {
      if (!forceCycleTimer) {
        return;
      }
      clearTimeout(forceCycleTimer);
      forceCycleTimer = undefined;
    };
    const stopRunner = () => {
      fetchAbortController?.abort();
      stopPromise ??= Promise.resolve(runner.stop())
        .then(() => undefined)
        .catch(() => undefined);
      return stopPromise;
    };
    let stopBotPromise: Promise<void> | undefined;
    const stopBot = () => {
      stopBotPromise ??= Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => undefined);
      return stopBotPromise;
    };
    const stopOnAbort = () => {
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    let restartRequested = false;
    let stopTimedOut = false;
    const requestStopForRestart = () => {
      if (restartRequested) {
        return;
      }
      restartRequested = true;
      void stopRunner();
      void stopBot();
      if (!forceCycleTimer) {
        forceCycleTimer = setTimeout(() => {
          if (this.opts.abortSignal?.aborted) {
            return;
          }
          this.opts.log(
            `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
          );
          stopTimedOut = true;
          forceCycleResolve?.();
        }, POLL_STOP_GRACE_MS);
      }
    };

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted || restartRequested) {
        return;
      }

      const stall = liveness.detectStall({
        thresholdMs: this.#stallThresholdMs,
      });
      if (stall) {
        this.#transportState.markDirty();
        stalledRestart = true;
        this.opts.log(`[telegram] ${stall.message}`);
        this.#status.notePollingError(stall.message);
        requestStopForRestart();
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      clearForceCycleTimer();
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      this.opts.log(
        `[telegram][diag] polling cycle finished reason=${reason} ${liveness.formatDiagnosticFields("error")}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
        { stopTimedOut },
      );
      return shouldRestart ? "continue" : "exit";
    } catch (err) {
      this.#forceRestarted = false;
      if (this.opts.abortSignal?.aborted) {
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      if (isConflict) {
        this.#webhookCleared = false;
      }
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      // Mark transport dirty on 409 conflict as well as recoverable network
      // errors. Without this, Telegram-side session termination returns 409
      // and the retry reuses the same HTTP keep-alive TCP socket, which
      // Telegram treats as the "old" session and keeps terminating — producing
      // a tight 409 retry loop at low but non-zero rate. (#69787)
      if (isRecoverable || isConflict) {
        this.#transportState.markDirty();
      }
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      const conflictHint = isConflict ? TELEGRAM_GET_UPDATES_CONFLICT_HINT : "";
      this.opts.log(
        `[telegram][diag] polling cycle error reason=${reason} ${liveness.formatDiagnosticFields("lastGetUpdatesError")} err=${errMsg}${conflictHint}`,
      );
      // Conflicts carry a user-fixable diagnosis, so surface them in channel
      // status. Recoverable network blips stay log-only; the stall watchdog
      // owns status for extended outages (see detectStall above).
      if (isConflict) {
        this.#status.notePollingError(`Telegram ${reason}: ${errMsg}.${conflictHint}`);
      }
      clearForceCycleTimer();
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg};${conflictHint} retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      clearForceCycleTimer();
      this.opts.abortSignal?.removeEventListener("abort", abortFetch);
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await waitForGracefulStop(stopRunner);
      await waitForGracefulStop(stopBot);
      this.#activeRunner = undefined;
      if (this.#activeCycleAbort === fetchAbortController) {
        this.#activeCycleAbort = undefined;
      }
    }
  }
}

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const normalizedHaystack = normalizeLowercaseStringOrEmpty(haystack);
  return normalizedHaystack.includes("getupdates");
};

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
