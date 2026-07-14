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
  ackSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  moveSessionDeliveryToFailed,
  pruneFailedOlderThan,
  type QueuedSessionDelivery,
} from "./session-delivery-queue-storage.js";

// Session delivery recovery replays persisted messages after crashes while
// bounding retry count, backoff, and concurrent drain work.
const FAILED_GC_AMORTIZATION_MS = 60_000;
let lastGcAt = 0;

// oxlint-disable-next-line eslint/no-underscore-dangle -- test-only reset hook
export function __resetFailedGcWatermarkForTests(): void {
  lastGcAt = 0;
}

async function maybePruneFailedRecords(opts: {
  failedMaxAgeMs?: number;
  stateDir?: string;
  log: SessionDeliveryRecoveryLogger;
  now: number;
}): Promise<void> {
  const { failedMaxAgeMs, stateDir, log, now } = opts;
  if (failedMaxAgeMs == null || !(failedMaxAgeMs > 0)) {
    return;
  }
  if (now - lastGcAt < FAILED_GC_AMORTIZATION_MS) {
    return;
  }
  try {
    const summary = await pruneFailedOlderThan(failedMaxAgeMs, now, stateDir);
    if (summary.removed > 0) {
      log.info(
        `Session delivery failed/ prune: removed ${summary.removed} of ${summary.scanned} entries older than ${failedMaxAgeMs}ms`,
      );
    }
  } catch (err) {
    log.warn(`Session delivery failed/ prune error: ${formatErrorMessage(err)}`);
  } finally {
    lastGcAt = now;
  }
}

export type SessionDeliveryRecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

export type DeliverSessionDeliveryFn = (entry: QueuedSessionDelivery) => Promise<void>;

export interface SessionDeliveryRecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PendingSessionDeliveryDrainDecision {
  match: boolean;
  bypassBackoff?: boolean;
}

export const MAX_SESSION_DELIVERY_RETRIES = 5;

const drainInProgress = new Map<string, boolean>();
const entriesInProgress = new Set<string>();
const recoveryReplayPacer = createRecoveryReplayPacer();

function createEmptyRecoverySummary(): SessionDeliveryRecoverySummary {
  return {
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  };
}

function formatRetryBudgetExhaustedLog(entry: QueuedSessionDelivery): string | null {
  if (entry.kind !== "postCompactionDelegate") {
    return null;
  }
  return `[session-delivery-queue:retry-budget-exhausted] entry ${entry.id} hit retry cap before post-compaction delegate spawn for session ${entry.sessionKey}: ${entry.task}`;
}

function logRetryBudgetExhausted(
  log: SessionDeliveryRecoveryLogger,
  entry: QueuedSessionDelivery,
): void {
  const message = formatRetryBudgetExhaustedLog(entry);
  if (message) {
    log.warn(message);
  }
}

function resolveSessionDeliveryMaxRetries(entry: QueuedSessionDelivery): number {
  return entry.maxRetries ?? MAX_SESSION_DELIVERY_RETRIES;
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
  onRecovered?: (entry: QueuedSessionDelivery) => void;
  onFailed?: (entry: QueuedSessionDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone"> {
  const { entry } = opts;
  try {
    await opts.deliver(entry);
    await ackSessionDelivery(entry.id, opts.stateDir);
    opts.onRecovered?.(entry);
    return "recovered";
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    opts.onFailed?.(entry, errMsg);
    try {
      await failSessionDelivery(entry.id, errMsg, opts.stateDir);
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
  selectEntry: (entry: QueuedSessionDelivery, now: number) => PendingSessionDeliveryDrainDecision;
  failedMaxAgeMs?: number;
}): Promise<void> {
  if (drainInProgress.get(opts.drainKey)) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
    return;
  }

  drainInProgress.set(opts.drainKey, true);
  try {
    await maybePruneFailedRecords({
      failedMaxAgeMs: opts.failedMaxAgeMs,
      stateDir: opts.stateDir,
      log: opts.log,
      now: Date.now(),
    });
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
        if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
          logRetryBudgetExhausted(opts.log, currentEntry);
          try {
            await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
          } catch (err) {
            if (getErrnoCode(err) !== "ENOENT") {
              throw err;
            }
          }
          opts.log.warn(
            `${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`,
          );
          continue;
        }

        if (!currentDecision.bypassBackoff) {
          const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            continue;
          }
        }

        await drainQueuedEntry({
          entry: currentEntry,
          deliver: opts.deliver,
          stateDir: opts.stateDir,
          onFailed: (failedEntry, errMsg) => {
            opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
          },
        });
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
  stateDir?: string;
  maxRecoveryMs?: number;
  maxEnqueuedAt?: number;
  failedMaxAgeMs?: number;
}): Promise<SessionDeliveryRecoverySummary> {
  await maybePruneFailedRecords({
    failedMaxAgeMs: opts.failedMaxAgeMs,
    stateDir: opts.stateDir,
    log: opts.log,
    now: Date.now(),
  });
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
      if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
        summary.skippedMaxRetries += 1;
        logRetryBudgetExhausted(opts.log, currentEntry);
        try {
          await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
        } catch (err) {
          if (getErrnoCode(err) !== "ENOENT") {
            throw err;
          }
        }
        continue;
      }

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

      const result = await drainQueuedEntry({
        entry: currentEntry,
        deliver: opts.deliver,
        stateDir: opts.stateDir,
        onRecovered: () => {
          summary.recovered += 1;
        },
        onFailed: (_failedEntry, errMsg) => {
          summary.failed += 1;
          opts.log.warn(`Session delivery retry failed: ${errMsg}`);
        },
      });
      if (result === "recovered") {
        opts.log.info(`Recovered session delivery ${currentEntry.id}`);
      }
    } finally {
      releaseSharedRecoveryEntry(entriesInProgress, entry.id);
    }
  }

  return summary;
}
