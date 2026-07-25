// Recovers queued session deliveries after process crashes.
import {
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import {
  claimRecoveryEntry as claimSharedRecoveryEntry,
  computeBackoffMs,
  createRecoveryReplayPacer,
  getErrnoCode,
  releaseRecoveryEntry as releaseSharedRecoveryEntry,
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

// Session delivery recovery replays persisted messages after crashes while
// bounding retry count, backoff, and concurrent drain work.
type SessionDeliveryRecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

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

interface PendingSessionDeliveryDrainDecision {
  match: boolean;
  bypassBackoff?: boolean;
}

const MAX_SESSION_DELIVERY_RETRIES = 5;

const drainInProgress = new Map<string, boolean>();
const entriesInProgress = new Set<string>();
const recoveryReplayPacer = createRecoveryReplayPacer();

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

function createEmptyRecoverySummary(): SessionDeliveryRecoverySummary {
  return {
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  };
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

function resolveSessionDeliveryRecoveryDeadlineMs(maxRecoveryMs: number | undefined): number {
  const durationMs = resolveNonNegativeIntegerOption(maxRecoveryMs, 60_000);
  if (durationMs <= 0) {
    return resolveDateTimestampMs(Date.now());
  }
  return resolveExpiresAtMsFromDurationMs(durationMs) ?? resolveDateTimestampMs(Date.now());
}

function isSessionDeliveryEligibleForRetry(
  entry: QueuedSessionDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  if (entry.availableAt && now < entry.availableAt) {
    return { eligible: false, remainingBackoffMs: entry.availableAt - now };
  }
  const backoff = computeBackoffMs(entry.retryCount);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const baseAttemptAt =
    typeof entry.lastAttemptAt === "number" && entry.lastAttemptAt > 0
      ? entry.lastAttemptAt
      : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
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
      return "failed";
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
  selectEntry: (entry: QueuedSessionDelivery, now: number) => PendingSessionDeliveryDrainDecision;
}): Promise<void> {
  if (drainInProgress.get(opts.drainKey)) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
    return;
  }

  drainInProgress.set(opts.drainKey, true);
  try {
    const matchingEntries = (await loadPendingSessionDeliveries(opts.stateDir))
      .filter((entry) => opts.selectEntry(entry, Date.now()).match)
      .toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);

    for (const entry of matchingEntries) {
      if (!claimSharedRecoveryEntry(entriesInProgress, entry.id)) {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
        continue;
      }

      try {
        const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
        if (!currentEntry) {
          continue;
        }
        const currentDecision = opts.selectEntry(currentEntry, Date.now());
        if (!currentDecision.match) {
          continue;
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
          continue;
        }

        if (!pendingSettlementOutcome && !currentDecision.bypassBackoff) {
          const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            continue;
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
      } finally {
        releaseSharedRecoveryEntry(entriesInProgress, entry.id);
      }
    }
  } finally {
    drainInProgress.delete(opts.drainKey);
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
}): Promise<SessionDeliveryRecoverySummary> {
  const pending = (await loadPendingSessionDeliveries(opts.stateDir)).filter(
    (entry) => opts.maxEnqueuedAt == null || entry.enqueuedAt <= opts.maxEnqueuedAt,
  );
  if (pending.length === 0) {
    return createEmptyRecoverySummary();
  }

  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const summary = createEmptyRecoverySummary();
  const deadline = resolveSessionDeliveryRecoveryDeadlineMs(opts.maxRecoveryMs);

  for (const entry of pending) {
    if (Date.now() >= deadline) {
      opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
      break;
    }
    if (!claimSharedRecoveryEntry(entriesInProgress, entry.id)) {
      continue;
    }

    try {
      const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
      if (!currentEntry) {
        continue;
      }
      if (opts.maxEnqueuedAt != null && currentEntry.enqueuedAt > opts.maxEnqueuedAt) {
        continue;
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
        continue;
      }

      if (!pendingSettlementOutcome) {
        const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
        if (!retryEligibility.eligible) {
          summary.deferredBackoff += 1;
          continue;
        }

        const paceResult = await recoveryReplayPacer.wait(deadline);
        if (paceResult === "deadline-exceeded") {
          opts.log.warn(
            "Session delivery recovery time budget exceeded — remaining entries deferred",
          );
          break;
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
    } finally {
      releaseSharedRecoveryEntry(entriesInProgress, entry.id);
    }
  }

  return summary;
}
