import { formatErrorMessage } from "./errors.js";
import {
  ackSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  moveSessionDeliveryToFailed,
  type QueuedSessionDelivery,
} from "./session-delivery-queue-storage.js";

type SessionDeliveryRecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

type DeliverSessionDeliveryFn = (entry: QueuedSessionDelivery) => Promise<void>;

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

const BACKOFF_MS: readonly number[] = [5_000, 25_000, 120_000, 600_000];
const drainInProgress = new Map<string, boolean>();
const entriesInProgress = new Set<string>();

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function createEmptyRecoverySummary(): SessionDeliveryRecoverySummary {
  return {
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  };
}

function claimRecoveryEntry(entryId: string): boolean {
  if (entriesInProgress.has(entryId)) {
    return false;
  }
  entriesInProgress.add(entryId);
  return true;
}

function releaseRecoveryEntry(entryId: string): void {
  entriesInProgress.delete(entryId);
}

function computeSessionDeliveryBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isSessionDeliveryEligibleForRetry(
  entry: QueuedSessionDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeSessionDeliveryBackoffMs(entry.retryCount);
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

export async function drainPendingSessionDeliveries(opts: {
  drainKey: string;
  logLabel: string;
  log: SessionDeliveryRecoveryLogger;
  stateDir?: string;
  deliver: DeliverSessionDeliveryFn;
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
      if (!claimRecoveryEntry(entry.id)) {
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
        if (currentEntry.retryCount >= MAX_SESSION_DELIVERY_RETRIES) {
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
        releaseRecoveryEntry(entry.id);
      }
    }
  } finally {
    drainInProgress.delete(opts.drainKey);
  }
}

export async function recoverPendingSessionDeliveries(opts: {
  deliver: DeliverSessionDeliveryFn;
  log: SessionDeliveryRecoveryLogger;
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
  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);

  for (const entry of pending) {
    if (Date.now() >= deadline) {
      opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
      break;
    }
    if (!claimRecoveryEntry(entry.id)) {
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
      if (currentEntry.retryCount >= MAX_SESSION_DELIVERY_RETRIES) {
        summary.skippedMaxRetries += 1;
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
      releaseRecoveryEntry(entry.id);
    }
  }

  return summary;
}
