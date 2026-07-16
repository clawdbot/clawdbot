// Telegram plugin module implements polling session behavior.
import { type RunOptions, run } from "@grammyjs/runner";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { formatDurationPrecise, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
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
import { getTelegramSequentialKey } from "./sequential-key.js";
import {
  resolveNonRetryableSpooledUpdateFailure,
  resolveSpooledUpdateAttemptNumber,
  resolveSpooledUpdateRetryDelayMs,
  shouldDeadLetterRetryableSpooledUpdate,
  TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS,
} from "./spooled-update-retry-policy.js";
import {
  isTelegramSpooledCorruptClaimOwnedByOtherLiveProcess,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
} from "./telegram-ingress-claim-owner.js";
import {
  abandonTelegramSpooledUpdateClaim,
  claimNextTelegramSpooledUpdate,
  completeTelegramSpooledUpdateWithRetry,
  failTelegramSpooledUpdateClaim,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  refreshTelegramSpooledUpdateClaim,
  releaseTelegramSpooledUpdateClaim,
  resolveTelegramIngressSpoolDir,
  writeTelegramSpooledUpdate,
  type ClaimedTelegramSpooledUpdate,
  type TelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";
import {
  createTelegramIngressWorker,
  type TelegramIngressWorkerFactory,
} from "./telegram-ingress-worker.js";
import {
  buildTelegramReplyFenceLaneKey,
  supersedeTelegramReplyFenceLane,
} from "./telegram-reply-fence.js";

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
const ISOLATED_INGRESS_BACKLOG_STALL_MS = 25 * 60_000;
// claim→adoption only; once adopted, run lifecycle owns the turn.
const ISOLATED_INGRESS_ADOPTION_STALL_MS = 5 * 60_000;
const TELEGRAM_SPOOLED_HANDLER_ABORT_GRACE_MS = 5_000;
const TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
const TELEGRAM_SPOOLED_DRAIN_START_LIMIT = 100;
const TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT = TELEGRAM_SPOOLED_DRAIN_START_LIMIT * 10;
const TELEGRAM_SPOOLED_CLAIM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_SPOOLED_CLAIM_HEALTH_GRACE_MS = 2 * TELEGRAM_SPOOLED_CLAIM_REFRESH_INTERVAL_MS;
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

const waitForSpooledHandlerTaskSettlement = async (params: {
  task: Promise<unknown>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<boolean> => {
  if (params.abortSignal?.aborted) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      params.task.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), params.timeoutMs);
        timer.unref?.();
        const abort = () => resolve(false);
        params.abortSignal?.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => params.abortSignal?.removeEventListener("abort", abort);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeAbortListener?.();
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

type SpooledUpdateHandlerState = {
  handlerKey: string;
  laneKey: string;
  task: Promise<boolean>;
  update: ClaimedTelegramSpooledUpdate;
  updateId: number;
  startedAt: number;
  stopClaimRefresh: () => void;
  backlogStatusMessage?: string;
  timedOutAt?: number;
  timeoutMessage?: string;
};

type DeferredSpooledUpdateClaimState = {
  claimKey: string;
  laneKey: string;
  task: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  timedOutMessage?: string;
  update: ClaimedTelegramSpooledUpdate;
  updateId: number;
  stopClaimRefresh: () => void;
};

const deferredSpooledUpdateClaimsByKey = new Map<string, DeferredSpooledUpdateClaimState>();

function buildDeferredSpooledUpdateClaimKey(update: ClaimedTelegramSpooledUpdate): string {
  return `${update.pendingPath}:${update.claim?.claimToken ?? update.claim?.processId ?? "claimed"}`;
}

type SpooledUpdateDrainResult = {
  blockedByLane: Set<string>;
  started: number;
};

// Account health restarts create a new session in the same process while an old
// spooled handler may still be running after shutdown grace.
const TELEGRAM_POLLING_SESSION_STATE_KEY = Symbol.for("openclaw.telegram.pollingSessionState");
type SpooledUpdateDrainHealth = {
  lastCompletedAt: number;
};

function getTelegramPollingSessionState(): {
  activeHandlersByLane: Map<string, SpooledUpdateHandlerState>;
  drainHealthBySpool: Map<string, SpooledUpdateDrainHealth>;
} {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[TELEGRAM_POLLING_SESSION_STATE_KEY] as
    | {
        activeHandlersByLane: Map<string, SpooledUpdateHandlerState>;
        drainHealthBySpool: Map<string, SpooledUpdateDrainHealth>;
      }
    | undefined;
  if (existing) {
    return existing;
  }
  const created = {
    activeHandlersByLane: new Map<string, SpooledUpdateHandlerState>(),
    drainHealthBySpool: new Map<string, SpooledUpdateDrainHealth>(),
  };
  globalRecord[TELEGRAM_POLLING_SESSION_STATE_KEY] = created;
  return created;
}

const {
  activeHandlersByLane: activeSpooledUpdateHandlersByLane,
  drainHealthBySpool: spooledUpdateDrainHealthBySpool,
} = getTelegramPollingSessionState();

function getSpooledUpdateDrainHealth(spoolDir: string): SpooledUpdateDrainHealth {
  const existing = spooledUpdateDrainHealthBySpool.get(spoolDir);
  if (existing) {
    return existing;
  }
  const created = { lastCompletedAt: Date.now() };
  spooledUpdateDrainHealthBySpool.set(spoolDir, created);
  return created;
}

function resolveSpooledUpdateHandlerTimeoutMs(params: {
  configured?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const candidates = [
    params.configured,
    Number(params.env?.[TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV]),
  ];
  for (const candidate of candidates) {
    const timeoutMs = clampPositiveTimerTimeoutMs(candidate);
    if (timeoutMs !== undefined) {
      return timeoutMs;
    }
  }
  return ISOLATED_INGRESS_ADOPTION_STALL_MS;
}

function buildSpooledUpdateHandlerKey(params: { spoolDir: string; laneKey: string }): string {
  return `${params.spoolDir}\0${params.laneKey}`;
}

function isSpooledUpdateHandlerKeyForSpool(handlerKey: string, spoolDir: string): boolean {
  return handlerKey.startsWith(`${spoolDir}\0`);
}

export class TelegramPollingSession {
  #restartBackoffState = createTelegramRestartBackoffState();
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeCycleAbort: AbortController | undefined;
  #spooledUpdateHandlerKeys = new Set<string>();
  #deferredSpooledUpdateClaimKeys = new Set<string>();
  #transportState: TelegramPollingTransportState;
  #status: ReturnType<typeof createTelegramPollingStatusPublisher>;
  #stallThresholdMs: number;
  #spooledUpdateHandlerTimeoutMs: number;
  #spooledUpdateHandlerAbortGraceMs: number;
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
    this.#spooledUpdateHandlerTimeoutMs = resolveSpooledUpdateHandlerTimeoutMs({
      ...(opts.isolatedIngress?.spooledUpdateHandlerTimeoutMs !== undefined
        ? { configured: opts.isolatedIngress.spooledUpdateHandlerTimeoutMs }
        : {}),
      env: process.env,
    });
    this.#spooledUpdateHandlerAbortGraceMs = resolvePositiveTimerTimeoutMs(
      opts.isolatedIngress?.spooledUpdateHandlerAbortGraceMs,
      TELEGRAM_SPOOLED_HANDLER_ABORT_GRACE_MS,
    );
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

  async #claimNextSpooledUpdate(params: {
    blockedLaneKeys: Set<string>;
    candidateUpdateIds: readonly number[];
    spoolDir: string;
  }): Promise<ClaimedTelegramSpooledUpdate | null> {
    try {
      return await claimNextTelegramSpooledUpdate({
        spoolDir: params.spoolDir,
        blockedLaneKeys: params.blockedLaneKeys,
        botInfo: this.opts.botInfo,
        candidateUpdateIds: params.candidateUpdateIds,
        scanLimit: TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT,
      });
    } catch (err) {
      this.opts.log(
        `[telegram][diag] spooled update claim failed; keeping pending updates for retry: ${formatErrorMessage(err)}`,
      );
      return null;
    }
  }

  #startSpooledUpdateClaimRefresh(
    update: ClaimedTelegramSpooledUpdate,
    isDrainHealthy: () => boolean,
    onDrainUnhealthy: () => void,
  ): () => void {
    // Refresh only while this process owns useful work and its drain loop is making progress.
    // Stopping the lease on a stalled drain lets another process recover the lane.
    let stopped = false;
    let refreshing = false;
    const refresh = async (): Promise<void> => {
      if (stopped || refreshing) {
        return;
      }
      if (!isDrainHealthy()) {
        onDrainUnhealthy();
        stopped = true;
        clearInterval(timer);
        return;
      }
      refreshing = true;
      try {
        const refreshed = await refreshTelegramSpooledUpdateClaim(update);
        if (!refreshed && !stopped) {
          onDrainUnhealthy();
          stopped = true;
          clearInterval(timer);
        }
      } catch (err) {
        this.opts.log(
          `[telegram][diag] spooled update ${update.updateId} claim refresh failed: ${formatErrorMessage(err)}`,
        );
        if (!stopped) {
          onDrainUnhealthy();
          stopped = true;
          clearInterval(timer);
        }
      } finally {
        refreshing = false;
      }
    };
    const timer = setInterval(() => {
      void refresh();
    }, TELEGRAM_SPOOLED_CLAIM_REFRESH_INTERVAL_MS);
    timer.unref?.();
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    };
  }

  async #handleClaimedSpooledUpdate(params: {
    bot: TelegramBot;
    onTurnAdopted: () => void;
    stopClaimRefresh: () => void;
    update: ClaimedTelegramSpooledUpdate;
  }): Promise<boolean> {
    let replay: { deferredWork?: TelegramSpooledReplayDeferredParticipant };
    try {
      const update = params.update.update as Parameters<typeof params.bot.handleUpdate>[0];
      replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
        await params.bot.handleUpdate(update);
      });
    } catch (err) {
      params.stopClaimRefresh();
      await this.#releaseFailedSpooledUpdate({
        err,
        update: params.update,
      });
      return false;
    }
    if (replay.deferredWork) {
      this.#registerDeferredSpooledUpdate({
        deferredWork: replay.deferredWork,
        laneKey: this.#spooledUpdateLaneKey(params.update),
        onTurnAdopted: params.onTurnAdopted,
        stopClaimRefresh: params.stopClaimRefresh,
        update: params.update,
      });
      return true;
    }
    try {
      await completeTelegramSpooledUpdateWithRetry({
        update: params.update,
        abortSignal: this.opts.abortSignal,
        onRetry: ({ attempt, delayMs, error }) => {
          this.opts.log(
            `[telegram][diag] spooled update ${params.update.updateId} completion retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}: ${formatErrorMessage(error)}`,
          );
        },
      });
      return true;
    } catch (err) {
      this.opts.log(
        `[telegram][diag] spooled update ${params.update.updateId} completed but could not tombstone its claimed spool row: ${formatErrorMessage(err)}`,
      );
      return false;
    }
  }

  #registerDeferredSpooledUpdate(params: {
    deferredWork: TelegramSpooledReplayDeferredParticipant;
    laneKey: string;
    onTurnAdopted: () => void;
    stopClaimRefresh: () => void;
    update: ClaimedTelegramSpooledUpdate;
  }): void {
    const claimKey = buildDeferredSpooledUpdateClaimKey(params.update);
    const previous = deferredSpooledUpdateClaimsByKey.get(claimKey);
    if (previous) {
      if (previous.timer) {
        clearTimeout(previous.timer);
      }
      previous.stopClaimRefresh();
      deferredSpooledUpdateClaimsByKey.delete(claimKey);
    }
    let settled = false;
    const releaseState = (): void => {
      state.stopClaimRefresh();
      if (deferredSpooledUpdateClaimsByKey.get(claimKey) === state) {
        deferredSpooledUpdateClaimsByKey.delete(claimKey);
      }
      this.#deferredSpooledUpdateClaimKeys.delete(claimKey);
    };
    const finish = async (result: TelegramMessageProcessingResult): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
      if (result.kind === "completed") {
        // Claim refresh must continue through tombstone retry, but durable
        // adoption transfers cancellation ownership away from ingress.
        params.onTurnAdopted();
      }
      if (result.kind === "failed-retryable") {
        releaseState();
        if (state.timedOutMessage) {
          await this.#failTimedOutDeferredSpooledUpdate(state);
          return;
        }
        await this.#releaseFailedSpooledUpdate({
          err: result.error,
          update: params.update,
        });
        return;
      }
      try {
        await completeTelegramSpooledUpdateWithRetry({
          update: params.update,
          abortSignal: this.opts.abortSignal,
          onRetry: ({ attempt, delayMs, error }) => {
            this.opts.log(
              `[telegram][diag] spooled update ${params.update.updateId} buffered completion retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}: ${formatErrorMessage(error)}`,
            );
          },
        });
      } catch (err) {
        this.opts.log(
          `[telegram][diag] spooled update ${params.update.updateId} completed after buffered processing but could not tombstone its claimed spool row: ${formatErrorMessage(err)}`,
        );
      } finally {
        releaseState();
      }
    };
    const state: DeferredSpooledUpdateClaimState = {
      claimKey,
      laneKey: params.laneKey,
      task: params.deferredWork.task.then(finish, async (err: unknown) => {
        await finish({ kind: "failed-retryable", error: err });
      }),
      update: params.update,
      updateId: params.update.updateId,
      stopClaimRefresh: params.stopClaimRefresh,
    };
    state.timer = setTimeout(() => {
      const age = formatDurationPrecise(this.#spooledUpdateHandlerTimeoutMs);
      // Pre-adoption only: once the deferred participant settles at adoption,
      // this timer is cleared. A fire means ingress never adopted the turn.
      state.timedOutMessage = `Telegram isolated polling spool pre-adoption timed out behind update ${params.update.updateId} on lane ${params.laneKey} after ${age}; marking the update failed (handler-timeout) and keeping the claim out of retry.`;
      params.deferredWork.settle({
        kind: "failed-retryable",
        error: new Error(state.timedOutMessage),
      });
    }, this.#spooledUpdateHandlerTimeoutMs);
    state.timer.unref?.();
    deferredSpooledUpdateClaimsByKey.set(claimKey, state);
    this.#deferredSpooledUpdateClaimKeys.add(claimKey);
  }

  #isDeferredSpooledUpdateClaim(update: ClaimedTelegramSpooledUpdate): boolean {
    return deferredSpooledUpdateClaimsByKey.has(buildDeferredSpooledUpdateClaimKey(update));
  }

  async #failTimedOutDeferredSpooledUpdate(state: DeferredSpooledUpdateClaimState): Promise<void> {
    const message =
      state.timedOutMessage ??
      `Telegram isolated polling spool pre-adoption timed out behind update ${state.updateId} on lane ${state.laneKey}; marking the update failed.`;
    try {
      const failed = await failTelegramSpooledUpdateClaim({
        update: state.update,
        reason: "handler-timeout",
        message,
      });
      if (!failed) {
        this.opts.log(
          `[telegram][diag] timed out pre-adoption spooled update ${state.updateId} no longer had a processing marker to fail.`,
        );
        this.#status.notePollingError(message);
        return;
      }
    } catch (err) {
      this.opts.log(
        `[telegram][diag] timed out pre-adoption spooled update ${state.updateId} could not be marked failed: ${formatErrorMessage(err)}`,
      );
      this.#status.notePollingError(message);
      return;
    }
    // Pre-adoption only: if a reply fence opened before adoption, release it.
    const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
      accountId: this.opts.accountId,
      sequentialKey: state.laneKey,
    });
    const abortedReplyWork = supersedeTelegramReplyFenceLane(scopedReplyFenceLaneKey);
    if (!abortedReplyWork) {
      this.opts.log(
        `[telegram][diag] timed out pre-adoption spooled update ${state.updateId} had no active reply fence on lane ${state.laneKey}.`,
      );
    }
    this.opts.log(`[telegram] ${message}`);
    this.#status.notePollingError(message);
  }

  async #releaseFailedSpooledUpdate(params: {
    err: unknown;
    update: ClaimedTelegramSpooledUpdate;
  }): Promise<void> {
    const laneKey = this.#spooledUpdateLaneKey(params.update);
    const nonRetryable = resolveNonRetryableSpooledUpdateFailure(params.err);
    if (nonRetryable) {
      try {
        const failed = await failTelegramSpooledUpdateClaim({
          update: params.update,
          reason: nonRetryable.reason,
          message: nonRetryable.message,
        });
        if (!failed) {
          this.opts.log(
            `[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}, but no processing marker remained to dead-letter.`,
          );
          return;
        }
        this.opts.log(
          `[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}; dead-lettered: ${nonRetryable.message}`,
        );
        return;
      } catch (failErr) {
        this.opts.log(
          `[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}, but could not be dead-lettered: ${formatErrorMessage(failErr)}`,
        );
      }
    }
    const attempt = resolveSpooledUpdateAttemptNumber(params.update);
    if (shouldDeadLetterRetryableSpooledUpdate(params.update, attempt)) {
      const message = formatErrorMessage(params.err);
      try {
        const failed = await failTelegramSpooledUpdateClaim({
          update: params.update,
          reason: "retry-limit-exceeded",
          message,
        });
        if (!failed) {
          this.opts.log(
            `[telegram][diag] spooled update ${params.update.updateId} on lane ${laneKey} reached retry limit, but no processing marker remained to dead-letter.`,
          );
          return;
        }
        // Retryable poison updates must eventually become tombstones, but not
        // during ordinary transient provider or state-store outages.
        this.opts.log(
          `[telegram][warn] spooled update ${params.update.updateId} on lane ${laneKey} reached retry limit after ${attempt} attempts; dead-lettered: ${message}`,
        );
        return;
      } catch (failErr) {
        this.opts.log(
          `[telegram][diag] spooled update ${params.update.updateId} on lane ${laneKey} reached retry limit, but could not be dead-lettered: ${formatErrorMessage(failErr)}`,
        );
      }
    }
    try {
      await releaseTelegramSpooledUpdateClaim(params.update, {
        lastError: formatErrorMessage(params.err),
      });
    } catch (releaseErr) {
      this.opts.log(
        `[telegram][diag] spooled update ${params.update.updateId} failed and could not be requeued: ${formatErrorMessage(releaseErr)}`,
      );
      return;
    }
    this.opts.log(
      `[telegram][diag] spooled update ${params.update.updateId} failed; keeping for retry attempt ${attempt + 1}/${TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS}: ${formatErrorMessage(params.err)}`,
    );
  }

  async #waitForSpooledUpdateHandlers(): Promise<void> {
    await Promise.allSettled([
      ...[...this.#spooledUpdateHandlerKeys]
        .map((handlerKey) => activeSpooledUpdateHandlersByLane.get(handlerKey)?.task)
        .filter((task): task is Promise<boolean> => Boolean(task)),
      ...[...this.#deferredSpooledUpdateClaimKeys]
        .map((claimKey) => deferredSpooledUpdateClaimsByKey.get(claimKey)?.task)
        .filter((task): task is Promise<void> => Boolean(task)),
    ]);
  }

  #spooledUpdateLaneKey(update: TelegramSpooledUpdate): string {
    return this.#rawSpooledUpdateLaneKey(update.update);
  }

  #rawSpooledUpdateLaneKey(update: unknown): string {
    return getTelegramSequentialKey({
      update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
      ...(this.opts.botInfo ? { me: this.opts.botInfo } : {}),
    });
  }

  #activeSpooledUpdateHandlerKeysForSpool(spoolDir: string): Set<string> {
    const handlerKeys = new Set<string>();
    for (const handlerKey of activeSpooledUpdateHandlersByLane.keys()) {
      if (isSpooledUpdateHandlerKeyForSpool(handlerKey, spoolDir)) {
        handlerKeys.add(handlerKey);
      }
    }
    return handlerKeys;
  }

  #activeSpooledUpdateLaneKeysForSpool(spoolDir: string): Set<string> {
    const laneKeys = new Set<string>();
    for (const handlerKey of this.#activeSpooledUpdateHandlerKeysForSpool(spoolDir)) {
      const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
      if (handler) {
        laneKeys.add(handler.laneKey);
      }
    }
    return laneKeys;
  }

  async #drainSpooledUpdates(params: {
    bot: TelegramBot;
    isDrainHealthy: () => boolean;
    shouldStop: () => boolean;
    spoolDir: string;
  }): Promise<SpooledUpdateDrainResult> {
    const activeLaneKeys = this.#activeSpooledUpdateLaneKeysForSpool(params.spoolDir);
    await recoverStaleTelegramSpooledUpdateClaims({
      spoolDir: params.spoolDir,
      staleMs: 0,
      shouldRecover: (claim) =>
        !this.#isDeferredSpooledUpdateClaim(claim) &&
        !activeLaneKeys.has(this.#spooledUpdateLaneKey(claim)) &&
        !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim),
      shouldRecoverCorrupt: (claim) =>
        !(claim.laneKey && activeLaneKeys.has(claim.laneKey)) &&
        !isTelegramSpooledCorruptClaimOwnedByOtherLiveProcess(claim),
    });
    const claimedLaneKeys = new Set(
      (
        await listTelegramSpooledUpdateClaims({
          spoolDir: params.spoolDir,
        })
      )
        .filter((claim) => !this.#isDeferredSpooledUpdateClaim(claim))
        .map((claim) => this.#spooledUpdateLaneKey(claim)),
    );
    const updates = await listTelegramSpooledUpdates({
      spoolDir: params.spoolDir,
      limit: TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT,
    });
    const candidateUpdateIds = updates.map((update) => update.updateId);
    const blockedByLane = new Set<string>();
    const retryDelayedLaneKeys = new Set<string>();
    for (const update of updates) {
      const laneKey = this.#spooledUpdateLaneKey(update);
      const handlerKey = buildSpooledUpdateHandlerKey({ spoolDir: params.spoolDir, laneKey });
      if (activeSpooledUpdateHandlersByLane.has(handlerKey)) {
        blockedByLane.add(handlerKey);
      }
      // Release increments attempts and stamps lastAttemptAt. The drain blocks
      // that lane until the retry window expires so poison rows cannot hot-loop.
      if (resolveSpooledUpdateRetryDelayMs(update) > 0) {
        retryDelayedLaneKeys.add(laneKey);
      }
    }
    const blockedLaneKeys = new Set([
      ...activeLaneKeys,
      ...claimedLaneKeys,
      ...retryDelayedLaneKeys,
    ]);
    let started = 0;
    while (started < TELEGRAM_SPOOLED_DRAIN_START_LIMIT) {
      if (params.shouldStop() || this.opts.abortSignal?.aborted) {
        break;
      }
      const claimedUpdate = await this.#claimNextSpooledUpdate({
        blockedLaneKeys,
        candidateUpdateIds,
        spoolDir: params.spoolDir,
      });
      if (!claimedUpdate) {
        break;
      }
      if (params.shouldStop() || this.opts.abortSignal?.aborted) {
        try {
          await abandonTelegramSpooledUpdateClaim(claimedUpdate);
        } catch (err) {
          this.opts.log(
            `[telegram][diag] spooled update ${claimedUpdate.updateId} could not be requeued after its polling cycle ended: ${formatErrorMessage(err)}`,
          );
        }
        break;
      }
      const laneKey = this.#spooledUpdateLaneKey(claimedUpdate);
      const handlerKey = buildSpooledUpdateHandlerKey({ spoolDir: params.spoolDir, laneKey });
      if (activeSpooledUpdateHandlersByLane.has(handlerKey)) {
        blockedByLane.add(handlerKey);
        await abandonTelegramSpooledUpdateClaim(claimedUpdate);
        blockedLaneKeys.add(laneKey);
        continue;
      }
      let abortReplyWorkOnClaimRefreshFailure = true;
      const stopClaimRefresh = this.#startSpooledUpdateClaimRefresh(
        claimedUpdate,
        params.isDrainHealthy,
        () => {
          if (!abortReplyWorkOnClaimRefreshFailure) {
            return;
          }
          const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
            accountId: this.opts.accountId,
            sequentialKey: laneKey,
          });
          const abortedReplyWork = supersedeTelegramReplyFenceLane(scopedReplyFenceLaneKey);
          if (!abortedReplyWork) {
            this.opts.log(
              `[telegram][diag] spooled update ${claimedUpdate.updateId} drain heartbeat expired without an active reply fence on lane ${laneKey}; stopping claim refresh.`,
            );
          }
        },
      );
      const handler = this.#handleClaimedSpooledUpdate({
        bot: params.bot,
        onTurnAdopted: () => {
          abortReplyWorkOnClaimRefreshFailure = false;
        },
        stopClaimRefresh,
        update: claimedUpdate,
      });
      const state: SpooledUpdateHandlerState = {
        handlerKey,
        laneKey,
        task: handler,
        update: claimedUpdate,
        updateId: claimedUpdate.updateId,
        startedAt: Date.now(),
        stopClaimRefresh,
      };
      activeSpooledUpdateHandlersByLane.set(handlerKey, state);
      this.#spooledUpdateHandlerKeys.add(handlerKey);
      blockedLaneKeys.add(laneKey);
      void handler.finally(() => {
        if (
          !deferredSpooledUpdateClaimsByKey.has(buildDeferredSpooledUpdateClaimKey(claimedUpdate))
        ) {
          state.stopClaimRefresh();
        }
        if (activeSpooledUpdateHandlersByLane.get(handlerKey) === state) {
          activeSpooledUpdateHandlersByLane.delete(handlerKey);
        }
        this.#spooledUpdateHandlerKeys.delete(handlerKey);
      });
      started += 1;
    }
    return { blockedByLane, started };
  }

  #detectTimedOutSpooledHandler(
    blockedHandlerKeys: Set<string>,
  ): { handler: SpooledUpdateHandlerState; ageMs: number } | null {
    const now = Date.now();
    let timedOut: { handler: SpooledUpdateHandlerState; ageMs: number } | null = null;
    for (const handlerKey of blockedHandlerKeys) {
      const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
      if (!handler || handler.timedOutAt !== undefined) {
        continue;
      }
      const ageMs = now - handler.startedAt;
      if (ageMs < this.#spooledUpdateHandlerTimeoutMs) {
        continue;
      }
      if (!timedOut || ageMs > timedOut.ageMs) {
        timedOut = { handler, ageMs };
      }
    }
    return timedOut;
  }

  async #recoverTimedOutSpooledHandler(
    blockedHandlerKeys: Set<string>,
  ): Promise<{ handlerKey: string; restart: boolean } | null> {
    const timedOutHandler = this.#detectTimedOutSpooledHandler(blockedHandlerKeys);
    if (!timedOutHandler) {
      return null;
    }
    const handler = timedOutHandler.handler;
    const activeHandler = activeSpooledUpdateHandlersByLane.get(handler.handlerKey);
    if (!activeHandler || activeHandler !== handler) {
      return null;
    }
    const age = formatDurationPrecise(timedOutHandler.ageMs);
    activeHandler.timedOutAt = Date.now();
    activeHandler.stopClaimRefresh();
    // Pre-adoption stall: the active handler should return once deferred work
    // is registered. A timeout here means ingress never reached adoption.
    const message = `Telegram isolated polling spool handler timed out behind update ${handler.updateId} on lane ${handler.laneKey} after ${age}; marking the update failed (handler-timeout / pre-adoption) and restarting isolated ingress so later updates can drain.`;
    activeHandler.timeoutMessage = message;
    try {
      const failed = await failTelegramSpooledUpdateClaim({
        update: handler.update,
        reason: "handler-timeout",
        message,
      });
      if (!failed) {
        this.opts.log(
          `[telegram][diag] timed out spooled update ${handler.updateId} no longer had a processing marker to fail.`,
        );
        this.#status.notePollingError(message);
        return { handlerKey: handler.handlerKey, restart: false };
      }
    } catch (err) {
      this.opts.log(
        `[telegram][diag] timed out spooled update ${handler.updateId} could not be marked failed: ${formatErrorMessage(err)}`,
      );
      this.#status.notePollingError(message);
      return { handlerKey: handler.handlerKey, restart: false };
    }
    // Best-effort: supersede any reply fence already opened during pre-adoption
    // setup so a wedged handleUpdate can return. After adoption the spool no
    // longer owns the turn, so this path should not see a settled agent run.
    const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
      accountId: this.opts.accountId,
      sequentialKey: handler.laneKey,
    });
    const abortedReplyWork = supersedeTelegramReplyFenceLane(scopedReplyFenceLaneKey);
    if (!abortedReplyWork) {
      this.opts.log(
        `[telegram][diag] timed out spooled update ${handler.updateId} had no active reply fence on lane ${handler.laneKey}; keeping the lane guarded until the handler stops.`,
      );
    }
    const handlerStopped = await waitForSpooledHandlerTaskSettlement({
      task: handler.task,
      timeoutMs: this.#spooledUpdateHandlerAbortGraceMs,
      abortSignal: this.opts.abortSignal,
    });
    if (
      !handlerStopped &&
      activeSpooledUpdateHandlersByLane.get(handler.handlerKey) === activeHandler
    ) {
      this.opts.log(
        `[telegram][diag] timed out spooled update ${handler.updateId} did not stop within ${formatDurationPrecise(this.#spooledUpdateHandlerAbortGraceMs)} after reply abort; keeping lane ${handler.laneKey} guarded.`,
      );
      this.#status.notePollingError(message);
      return { handlerKey: handler.handlerKey, restart: false };
    }
    if (activeSpooledUpdateHandlersByLane.get(handler.handlerKey) === activeHandler) {
      activeSpooledUpdateHandlersByLane.delete(handler.handlerKey);
    }
    this.#spooledUpdateHandlerKeys.delete(handler.handlerKey);
    this.opts.log(`[telegram] ${message}`);
    this.#status.notePollingError(message);
    return { handlerKey: handler.handlerKey, restart: true };
  }

  #noteSpooledBacklogStalls(blockedHandlerKeys: Set<string>): Set<string> {
    const stalled = new Set<string>();
    const now = Date.now();
    for (const handlerKey of blockedHandlerKeys) {
      const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
      if (!handler || handler.timedOutAt !== undefined) {
        continue;
      }
      const ageMs = now - handler.startedAt;
      if (ageMs < ISOLATED_INGRESS_BACKLOG_STALL_MS) {
        continue;
      }
      stalled.add(handlerKey);
      if (!handler.backlogStatusMessage) {
        handler.backlogStatusMessage = `Telegram isolated polling spool backlog stalled behind update ${handler.updateId} on lane ${handler.laneKey} for ${formatDurationPrecise(ageMs)}; marking polling unhealthy until the backlog drains.`;
        this.#status.notePollingError(handler.backlogStatusMessage);
      }
    }
    return stalled;
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
    const stalledBacklogKeys = new Set<string>();
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
        if (!restartRequested && stalledBacklogKeys.size === 0) {
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
          laneKey: this.#rawSpooledUpdateLaneKey(message.update),
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
    const drainHealth = getSpooledUpdateDrainHealth(spoolDir);
    // Fail closed when the spool stops making progress: keeping any claim live would
    // prevent a healthy process from recovering a wedged drain.
    const isDrainHealthy = () =>
      Date.now() - drainHealth.lastCompletedAt <= TELEGRAM_SPOOLED_CLAIM_HEALTH_GRACE_MS;
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
        const drain = await this.#drainSpooledUpdates({
          bot,
          isDrainHealthy,
          shouldStop: () => cycleEnding,
          spoolDir,
        });
        consecutiveDrainFailures = 0;
        for (const handlerKey of stalledBacklogKeys) {
          if (
            !activeSpooledUpdateHandlersByLane.has(handlerKey) ||
            !drain.blockedByLane.has(handlerKey)
          ) {
            stalledBacklogKeys.delete(handlerKey);
          }
        }
        for (const handlerKey of drain.blockedByLane) {
          const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
          if (handler?.timedOutAt === undefined) {
            continue;
          }
          stalledBacklogKeys.add(handlerKey);
          if (handler.timeoutMessage) {
            this.#status.notePollingError(handler.timeoutMessage);
          }
        }
        for (const handlerKey of this.#noteSpooledBacklogStalls(drain.blockedByLane)) {
          stalledBacklogKeys.add(handlerKey);
        }
        // Active handlers can outlive their owning session after shutdown grace.
        // Recover every handler for this spool, including lone handlers with no backlog.
        const timeoutCandidateHandlerKeys = this.#activeSpooledUpdateHandlerKeysForSpool(spoolDir);
        for (const handlerKey of drain.blockedByLane) {
          timeoutCandidateHandlerKeys.add(handlerKey);
        }
        const timedOutRecovery = await this.#recoverTimedOutSpooledHandler(
          timeoutCandidateHandlerKeys,
        );
        if (timedOutRecovery?.restart) {
          requestStopForRestart();
        } else if (timedOutRecovery) {
          stalledBacklogKeys.add(timedOutRecovery.handlerKey);
        }
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
        await waitForGracefulStop(() => this.#waitForSpooledUpdateHandlers());
      }
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
