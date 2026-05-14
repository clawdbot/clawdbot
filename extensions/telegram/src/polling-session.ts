import { type RunOptions, run } from "@grammyjs/runner";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  computeBackoff,
  formatDurationPrecise,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { type TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";
import { createTelegramPollingStatusPublisher } from "./polling-status.js";
import { TelegramPollingTransportState } from "./polling-transport-state.js";
import { TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";
import {
  deleteTelegramSpooledUpdate,
  listTelegramSpooledUpdates,
  resolveTelegramIngressSpoolDir,
} from "./telegram-ingress-spool.js";
import {
  createTelegramIngressWorker,
  type TelegramIngressWorkerFactory,
} from "./telegram-ingress-worker.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const DEFAULT_POLL_STALL_THRESHOLD_MS = 120_000;
const MIN_POLL_STALL_THRESHOLD_MS = 30_000;
const MAX_POLL_STALL_THRESHOLD_MS = 600_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;
const TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS = Math.ceil(
  TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1000,
);

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
  config: Parameters<typeof createTelegramBot>[0]["config"];
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
  };
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;
  #transportState: TelegramPollingTransportState;
  #status: ReturnType<typeof createTelegramPollingStatusPublisher>;
  #stallThresholdMs: number;

  constructor(private readonly opts: TelegramPollingSessionOpts) {
    this.#transportState = new TelegramPollingTransportState({
      log: opts.log,
      initialTransport: opts.telegramTransport,
      createTelegramTransport: opts.createTelegramTransport,
    });
    this.#status = createTelegramPollingStatusPublisher(opts.setStatus);
    this.#stallThresholdMs = resolvePollingStallThresholdMs(opts.stallThresholdMs);
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
    this.#activeFetchAbort?.abort();
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

  async #waitBeforeRestart(buildLine: (delay: string) => string): Promise<boolean> {
    this.#restartAttempts += 1;
    const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
    const delay = formatDurationPrecise(delayMs);
    this.opts.log(buildLine(delay));
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

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const fetchAbortController = new AbortController();
    this.#activeFetchAbort = fetchAbortController;
    const telegramTransport = this.#transportState.acquireForNextCycle();
    const updateOffset = this.opts.isolatedIngress?.enabled
      ? undefined
      : {
          lastUpdateId: this.opts.getLastUpdateId(),
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
        fetchAbortSignal: fetchAbortController.signal,
        minimumClientTimeoutSeconds: TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS,
        ...(updateOffset ? { updateOffset } : {}),
        telegramTransport,
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
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

  async #drainSpooledUpdates(params: { bot: TelegramBot; spoolDir: string }): Promise<number> {
    let handled = 0;
    const updates = await listTelegramSpooledUpdates({ spoolDir: params.spoolDir, limit: 100 });
    for (const update of updates) {
      if (this.opts.abortSignal?.aborted) {
        break;
      }
      try {
        await params.bot.handleUpdate(
          update.update as Parameters<typeof params.bot.handleUpdate>[0],
        );
        await deleteTelegramSpooledUpdate(update);
        handled += 1;
      } catch (err) {
        this.opts.log(
          `[telegram][diag] spooled update ${update.updateId} handler failed; keeping for retry: ${formatErrorMessage(err)}`,
        );
        break;
      }
    }
    return handled;
  }

  async #runIsolatedIngressCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    const ingress = this.opts.isolatedIngress;
    if (!ingress?.enabled) {
      return this.#runPollingCycle(bot);
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
    this.opts.log(`[telegram][diag] isolated polling ingress started spool=${spoolDir}`);
    const pollState: {
      startedAt: number | null;
      offset: number | null;
      outcome: string;
      error?: string;
    } = {
      startedAt: null,
      offset: null,
      outcome: "not-started",
    };
    let consecutiveDrainFailures = 0;
    const unsubscribe = worker.onMessage((message) => {
      if (message.type === "poll-start") {
        pollState.startedAt = message.startedAt;
        pollState.offset = message.offset;
        pollState.outcome = "started";
        delete pollState.error;
        return;
      }
      if (message.type === "poll-success") {
        this.#status.notePollSuccess(message.finishedAt);
        pollState.outcome = `ok:${message.count}`;
        return;
      }
      if (message.type === "poll-error") {
        pollState.outcome = "error";
        pollState.error = message.message;
      }
    });
    const stopOnAbort = () => {
      void worker.stop();
    };
    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    const drainIntervalMs = Math.max(100, Math.floor(ingress.drainIntervalMs ?? 500));
    let drainActive = false;
    const drainOnce = async () => {
      if (drainActive || this.opts.abortSignal?.aborted) {
        return;
      }
      drainActive = true;
      try {
        await this.#drainSpooledUpdates({ bot, spoolDir });
        consecutiveDrainFailures = 0;
      } catch (err) {
        consecutiveDrainFailures += 1;
        this.opts.log(
          `[telegram][diag] isolated polling spool drain failed (${consecutiveDrainFailures}): ${formatErrorMessage(err)}`,
        );
      } finally {
        drainActive = false;
      }
    };
    await drainOnce();
    const drainTimer = setInterval(() => {
      void drainOnce();
    }, drainIntervalMs);
    drainTimer.unref?.();
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => {
          // Bot may already be stopped by shutdown paths.
        });
    };
    try {
      await worker.task();
      if (this.opts.abortSignal?.aborted) {
        return "exit";
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
      clearInterval(drainTimer);
      unsubscribe();
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await worker.stop();
      await drainOnce();
      await waitForGracefulStop(stopBot);
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    const liveness = new TelegramPollingLivenessTracker({
      onPollSuccess: (finishedAt) => this.#status.notePollSuccess(finishedAt),
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
        liveness.noteGetUpdatesError(err);
        throw err;
      } finally {
        liveness.noteGetUpdatesFinished();
      }
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.opts.log(`[telegram][diag] polling cycle started ${liveness.formatDiagnosticFields()}`);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
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
    const stopRunner = () => {
      fetchAbortController?.abort();
      stopPromise ??= Promise.resolve(runner.stop())
        .then(() => undefined)
        .catch(() => {
          // Runner may already be stopped by abort/retry paths.
        });
      return stopPromise;
    };
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => {
          // Bot may already be stopped by runner stop/abort paths.
        });
    };
    const stopOnAbort = () => {
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
        return;
      }

      const stall = liveness.detectStall({
        thresholdMs: this.#stallThresholdMs,
      });
      if (stall) {
        this.#transportState.markDirty();
        stalledRestart = true;
        this.opts.log(`[telegram] ${stall.message}`);
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
            forceCycleResolve?.();
          }, POLL_STOP_GRACE_MS);
        }
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
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
      const conflictHint = isConflict
        ? " Another OpenClaw gateway, script, or Telegram poller may be using this bot token; stop the duplicate poller or switch this account to webhook mode."
        : "";
      this.opts.log(
        `[telegram][diag] polling cycle error reason=${reason} ${liveness.formatDiagnosticFields("lastGetUpdatesError")} err=${errMsg}${conflictHint}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg};${conflictHint} retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      if (forceCycleTimer) {
        clearTimeout(forceCycleTimer);
      }
      this.opts.abortSignal?.removeEventListener("abort", abortFetch);
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await waitForGracefulStop(stopRunner);
      await waitForGracefulStop(stopBot);
      this.#activeRunner = undefined;
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
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
