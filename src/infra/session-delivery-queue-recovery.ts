// Recovers queued session deliveries after process crashes.
import {
  createDeliveryRecoveryCoordinator,
  createEmptyDeliveryRecoverySummary,
  getErrnoCode,
  isDeliveryRecoveryRetryEligible,
  resolveDeliveryRecoveryDeadlineMs,
  type DeliveryRecoveryDrainDecision,
  type DeliveryRecoverySummary,
} from "./delivery-recovery.shared.js";
import { formatErrorMessage } from "./errors.js";
import {
  completeSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliverySettlement,
  moveSessionDeliveryToFailed,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type SessionDeliverySettledOutcome,
} from "./session-delivery-queue-storage.js";

export type DeliverSessionDeliveryFn = (
  entry: QueuedSessionDelivery,
  context?: { stateDir?: string },
) => Promise<void>;
export type SettleSessionDeliveryFn = (
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
) => Promise<void> | void;

export interface SessionDeliveryRecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const MAX_SESSION_DELIVERY_RETRIES = 5;

const recoveryCoordinator = createDeliveryRecoveryCoordinator<QueuedSessionDelivery>();

async function notifySessionDeliverySettled(params: {
  entry: QueuedSessionDelivery;
  log: SessionDeliveryRecoveryLogger;
  onSettled?: SettleSessionDeliveryFn;
  outcome: SessionDeliverySettledOutcome;
}): Promise<boolean> {
  try {
    await params.onSettled?.(params.entry, params.outcome);
    return true;
  } catch (error) {
    params.log.error(
      `session delivery: settled callback failed for ${params.entry.id}: ${String(error)}`,
    );
    return false;
  }
}

async function finalizeSessionDeliverySettlement(params: {
  entry: QueuedSessionDelivery;
  log: SessionDeliveryRecoveryLogger;
  onSettled?: SettleSessionDeliveryFn;
  outcome: SessionDeliverySettledOutcome;
  stateDir?: string;
}): Promise<boolean> {
  const callbackSettled = await notifySessionDeliverySettled(params);
  if (!callbackSettled) {
    return false;
  }
  try {
    if (params.outcome === "recovered") {
      await completeSessionDelivery(params.entry.id, params.stateDir);
    } else {
      await moveSessionDeliveryToFailed(params.entry.id, params.stateDir);
    }
    return true;
  } catch (error) {
    params.log.error(
      `session delivery: ${params.outcome} finalization failed for ${params.entry.id}: ${String(error)}`,
    );
    return false;
  }
}

function resolvePendingSettlementOutcome(
  entry: QueuedSessionDelivery,
): SessionDeliverySettledOutcome | undefined {
  return entry.settlementOutcome ?? (entry.acknowledgedAt !== undefined ? "recovered" : undefined);
}

function resolveSessionDeliveryMaxRetries(entry: QueuedSessionDelivery): number {
  return entry.maxRetries ?? MAX_SESSION_DELIVERY_RETRIES;
}

function canReconcileStartedAgentAttemptAtRetryLimit(entry: QueuedSessionDelivery): boolean {
  return (
    entry.kind === "agentTurn" &&
    entry.deliveryStartedAt !== undefined &&
    entry.retryCount === resolveSessionDeliveryMaxRetries(entry)
  );
}

function resolveSessionRetryEligibility(entry: QueuedSessionDelivery, now: number) {
  if (entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion") {
    if (now >= entry.owner.deadlineAt) {
      return { eligible: true } as const;
    }
    const remainingBackoffMs = Math.max(0, (entry.availableAt ?? 0) - now);
    return remainingBackoffMs > 0
      ? ({ eligible: false, remainingBackoffMs } as const)
      : ({ eligible: true } as const);
  }
  return isDeliveryRecoveryRetryEligible(entry, now);
}

async function drainQueuedEntry(opts: {
  entry: QueuedSessionDelivery;
  deliver: DeliverSessionDeliveryFn;
  stateDir?: string;
  onFailed?: (entry: QueuedSessionDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "deferred" | "moved-to-failed" | "already-gone"> {
  const { entry } = opts;
  try {
    const pendingOutcome = resolvePendingSettlementOutcome(entry);
    if (pendingOutcome) {
      return pendingOutcome;
    }
    await opts.deliver(entry, { stateDir: opts.stateDir });
    // Keep route/session metadata pending until owner cleanup succeeds. Recovery
    // sees this marker and finalizes without replaying the external side effect.
    await markSessionDeliverySettlement(entry, "recovered", opts.stateDir);
    return "recovered";
  } catch (err) {
    if (err instanceof SessionDeliveryDeadLetteredError) {
      try {
        await markSessionDeliverySettlement(entry, "moved-to-failed", opts.stateDir);
      } catch (markError) {
        if (markError instanceof SessionDeliveryAcknowledgementFinalizeError) {
          return "deferred";
        }
        throw markError;
      }
      return "moved-to-failed";
    }
    if (err instanceof SessionDeliveryDeferredError) {
      return "deferred";
    }
    if (err instanceof SessionDeliveryAcknowledgementFinalizeError) {
      return "deferred";
    }
    if (err instanceof SessionDeliveryAttemptStartError) {
      return "deferred";
    }
    const errMsg = formatErrorMessage(err);
    opts.onFailed?.(entry, errMsg);
    if (err instanceof SessionDeliveryRetryChargedError) {
      return "failed";
    }
    try {
      await failSessionDelivery(entry.id, errMsg, opts.stateDir, {
        releaseAttemptOwnership: err instanceof SessionDeliverySafeRetryError,
      });
      return "failed";
    } catch (failErr) {
      if (getErrnoCode(failErr) === "ENOENT") {
        return "already-gone";
      }
      // A non-ENOENT persistence failure here means the retry metadata
      // (retryCount/lastAttemptAt) never advanced, so swallowing it as "failed"
      // re-drives the same entry forever without progressing toward the
      // max-retries terminal move. Surface it like the sibling moveToFailed
      // paths below, which also re-throw non-ENOENT.
      throw failErr;
    }
  }
}

/** Drain matching queued session deliveries with retry/backoff protection. */
export async function drainPendingSessionDeliveries(opts: {
  drainKey: string;
  logLabel: string;
  log: SessionDeliveryRecoveryLogger;
  stateDir?: string;
  deliver: DeliverSessionDeliveryFn;
  onSettled?: SettleSessionDeliveryFn;
  selectEntry: (entry: QueuedSessionDelivery, now: number) => DeliveryRecoveryDrainDecision;
}): Promise<void> {
  const drained = await recoveryCoordinator.withDrain(opts.drainKey, async () => {
    const matchingEntries = (await loadPendingSessionDeliveries(opts.stateDir)).filter(
      (entry) => opts.selectEntry(entry, Date.now()).match,
    );
    await recoveryCoordinator.scan({
      entries: matchingEntries,
      loadEntry: (id) => loadPendingSessionDelivery(id, opts.stateDir),
      onClaimConflict: (entry) => {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
      },
      onEntry: async (currentEntry) => {
        const currentDecision = opts.selectEntry(currentEntry, Date.now());
        if (!currentDecision.match) {
          return;
        }
        const pendingSettlementOutcome = resolvePendingSettlementOutcome(currentEntry);
        if (
          !pendingSettlementOutcome &&
          !canReconcileStartedAgentAttemptAtRetryLimit(currentEntry) &&
          currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)
        ) {
          await markSessionDeliverySettlement(currentEntry, "moved-to-failed", opts.stateDir);
          const finalized = await finalizeSessionDeliverySettlement({
            entry: currentEntry,
            log: opts.log,
            onSettled: opts.onSettled,
            outcome: "moved-to-failed",
            stateDir: opts.stateDir,
          });
          if (finalized) {
            opts.log.warn(
              `${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed`,
            );
          }
          return;
        }

        if (!pendingSettlementOutcome && !currentDecision.bypassBackoff) {
          const retryEligibility = resolveSessionRetryEligibility(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            return;
          }
        }

        const result = await drainQueuedEntry({
          entry: currentEntry,
          deliver: opts.deliver,
          stateDir: opts.stateDir,
          onFailed: (failedEntry, errMsg) => {
            opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
          },
        });
        if (result === "recovered" || result === "moved-to-failed") {
          await finalizeSessionDeliverySettlement({
            entry: currentEntry,
            log: opts.log,
            onSettled: opts.onSettled,
            outcome: result,
            stateDir: opts.stateDir,
          });
        }
      },
    });
  });
  if (!drained) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
  }
}

/** Replay pending session deliveries until the recovery budget is exhausted. */
export async function recoverPendingSessionDeliveries(opts: {
  deliver: DeliverSessionDeliveryFn;
  log: SessionDeliveryRecoveryLogger;
  onSettled?: SettleSessionDeliveryFn;
  stateDir?: string;
  maxRecoveryMs?: number;
  maxEnqueuedAt?: number;
}): Promise<DeliveryRecoverySummary> {
  const pending = (await loadPendingSessionDeliveries(opts.stateDir)).filter(
    (entry) => opts.maxEnqueuedAt == null || entry.enqueuedAt <= opts.maxEnqueuedAt,
  );
  if (pending.length === 0) {
    return createEmptyDeliveryRecoverySummary();
  }

  const summary = createEmptyDeliveryRecoverySummary();
  const deadline = resolveDeliveryRecoveryDeadlineMs(opts.maxRecoveryMs);
  const onDeadlineExceeded = () => {
    opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
  };
  await recoveryCoordinator.scan({
    entries: pending,
    loadEntry: (id) => loadPendingSessionDelivery(id, opts.stateDir),
    deadlineMs: deadline,
    onDeadlineExceeded,
    onEntry: async (currentEntry) => {
      if (opts.maxEnqueuedAt != null && currentEntry.enqueuedAt > opts.maxEnqueuedAt) {
        return "continue";
      }
      const pendingSettlementOutcome = resolvePendingSettlementOutcome(currentEntry);
      if (
        !pendingSettlementOutcome &&
        !canReconcileStartedAgentAttemptAtRetryLimit(currentEntry) &&
        currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)
      ) {
        summary.skippedMaxRetries += 1;
        await markSessionDeliverySettlement(currentEntry, "moved-to-failed", opts.stateDir);
        await finalizeSessionDeliverySettlement({
          entry: currentEntry,
          log: opts.log,
          onSettled: opts.onSettled,
          outcome: "moved-to-failed",
          stateDir: opts.stateDir,
        });
        return "continue";
      }

      if (!pendingSettlementOutcome) {
        const retryEligibility = resolveSessionRetryEligibility(currentEntry, Date.now());
        if (!retryEligibility.eligible) {
          summary.deferredBackoff += 1;
          return "continue";
        }

        const paceResult = await recoveryCoordinator.waitForReplay(deadline);
        if (paceResult === "deadline-exceeded") {
          onDeadlineExceeded();
          return "stop";
        }
      }

      const result = await drainQueuedEntry({
        entry: currentEntry,
        deliver: opts.deliver,
        stateDir: opts.stateDir,
        onFailed: (_failedEntry, errMsg) => {
          summary.failed += 1;
          opts.log.warn(`Session delivery retry failed: ${errMsg}`);
        },
      });
      if (result === "recovered" || result === "moved-to-failed") {
        const finalized = await finalizeSessionDeliverySettlement({
          entry: currentEntry,
          log: opts.log,
          onSettled: opts.onSettled,
          outcome: result,
          stateDir: opts.stateDir,
        });
        if (finalized && result === "recovered") {
          summary.recovered += 1;
          opts.log.info(`Recovered session delivery ${currentEntry.id}`);
        }
      }
      return "continue";
    },
  });

  return summary;
}
