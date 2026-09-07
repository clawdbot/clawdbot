// Recovers queued session deliveries after process crashes.
import {
  createDeliveryRecoveryCoordinator,
  createEmptyDeliveryRecoverySummary,
  getErrnoCode,
  isDeliveryRecoveryRetryEligible,
  resolveDeliveryRecoveryDeadlineMs,
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

type SessionDeliveryDrainContext = {
  logLabel: string;
  log: SessionDeliveryRecoveryLogger;
  stateDir?: string;
  deliver: DeliverSessionDeliveryFn;
  onSettled?: SettleSessionDeliveryFn;
};

async function processPendingSessionDelivery(opts: {
  entry: QueuedSessionDelivery;
  context: SessionDeliveryDrainContext;
  bypassBackoff?: boolean;
  beforeDelivery?: () => Promise<"continue" | "stop">;
  onFailed?: (entry: QueuedSessionDelivery, errMsg: string) => void;
}) {
  const { entry, context } = opts;
  const pendingSettlementOutcome = resolvePendingSettlementOutcome(entry);
  if (pendingSettlementOutcome) {
    const finalized = await finalizeSessionDeliverySettlement({
      entry,
      log: context.log,
      onSettled: context.onSettled,
      outcome: pendingSettlementOutcome,
      stateDir: context.stateDir,
    });
    return { status: pendingSettlementOutcome, finalized };
  }
  if (
    !canReconcileStartedAgentAttemptAtRetryLimit(entry) &&
    entry.retryCount >= resolveSessionDeliveryMaxRetries(entry)
  ) {
    await markSessionDeliverySettlement(entry, "moved-to-failed", context.stateDir);
    const finalized = await finalizeSessionDeliverySettlement({
      entry,
      log: context.log,
      onSettled: context.onSettled,
      outcome: "moved-to-failed",
      stateDir: context.stateDir,
    });
    return { status: "max-retries", finalized };
  }

  if (!opts.bypassBackoff) {
    const retryEligibility = resolveSessionRetryEligibility(entry, Date.now());
    if (!retryEligibility.eligible) {
      return {
        status: "backoff",
        remainingMs: retryEligibility.remainingBackoffMs,
      };
    }
  }
  if ((await opts.beforeDelivery?.()) === "stop") {
    return { status: "stop" };
  }

  let result: SessionDeliverySettledOutcome;
  try {
    await context.deliver(entry, { stateDir: context.stateDir });
    // Keep metadata pending until owner cleanup succeeds. Recovery sees this
    // marker and finalizes without replaying the external side effect.
    await markSessionDeliverySettlement(entry, "recovered", context.stateDir);
    result = "recovered";
  } catch (err) {
    if (err instanceof SessionDeliveryDeadLetteredError) {
      try {
        await markSessionDeliverySettlement(entry, "moved-to-failed", context.stateDir);
      } catch (markError) {
        if (markError instanceof SessionDeliveryAcknowledgementFinalizeError) {
          return { status: "deferred" };
        }
        throw markError;
      }
      result = "moved-to-failed";
    } else if (
      err instanceof SessionDeliveryDeferredError ||
      err instanceof SessionDeliveryAcknowledgementFinalizeError ||
      err instanceof SessionDeliveryAttemptStartError
    ) {
      return { status: "deferred" };
    } else {
      const errMsg = formatErrorMessage(err);
      opts.onFailed?.(entry, errMsg);
      if (err instanceof SessionDeliveryRetryChargedError) {
        return { status: "failed" };
      }
      try {
        await failSessionDelivery(entry.id, errMsg, context.stateDir, {
          releaseAttemptOwnership: err instanceof SessionDeliverySafeRetryError,
        });
      } catch (failErr) {
        if (getErrnoCode(failErr) === "ENOENT") {
          return { status: "already-gone" };
        }
        // Retry metadata did not advance, so swallowing this would redrive the
        // entry forever without progressing toward the terminal retry limit.
        throw failErr;
      }
      return { status: "failed" };
    }
  }
  const finalized = await finalizeSessionDeliverySettlement({
    entry,
    log: context.log,
    onSettled: context.onSettled,
    outcome: result,
    stateDir: context.stateDir,
  });
  return { status: result, finalized };
}

async function processDrainedSessionDelivery(
  entry: QueuedSessionDelivery,
  context: SessionDeliveryDrainContext,
  bypassBackoff?: boolean,
) {
  const result = await processPendingSessionDelivery({
    entry,
    context,
    bypassBackoff,
    onFailed: (failedEntry, errMsg) => {
      context.log.warn(`${context.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
    },
  });
  if (result.status === "max-retries" && result.finalized) {
    context.log.warn(
      `${context.logLabel}: entry ${entry.id} exceeded max retries and was moved to failed`,
    );
  } else if (result.status === "backoff") {
    context.log.info(
      `${context.logLabel}: entry ${entry.id} not ready for retry yet — backoff ${result.remainingMs}ms remaining`,
    );
  }
  return result;
}

/** Drain one exact queued session delivery and return its final pending state. */
export async function drainPendingSessionDelivery(
  opts: SessionDeliveryDrainContext & { id: string; bypassBackoff?: boolean },
): Promise<QueuedSessionDelivery | null> {
  const claim = await recoveryCoordinator.withClaim(opts.id, async () => {
    const entry = await loadPendingSessionDelivery(opts.id, opts.stateDir);
    if (!entry) {
      return null;
    }
    const result = await processDrainedSessionDelivery(entry, opts, opts.bypassBackoff);
    if (result.status === "already-gone" || ("finalized" in result && result.finalized)) {
      return null;
    }
    return result.status === "backoff" ? entry : loadPendingSessionDelivery(opts.id, opts.stateDir);
  });
  if (claim.status === "claimed-by-other-owner") {
    opts.log.info(`${opts.logLabel}: entry ${opts.id} is already being recovered`);
    return loadPendingSessionDelivery(opts.id, opts.stateDir);
  }
  return claim.value;
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
  const context: SessionDeliveryDrainContext = { ...opts, logLabel: "Session delivery" };
  const beforeDelivery = async () => {
    const paceResult = await recoveryCoordinator.waitForReplay(deadline);
    if (paceResult === "deadline-exceeded") {
      onDeadlineExceeded();
      return "stop" as const;
    }
    return "continue" as const;
  };
  const onFailed = (_failedEntry: QueuedSessionDelivery, errMsg: string) => {
    summary.failed += 1;
    opts.log.warn(`Session delivery retry failed: ${errMsg}`);
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
      const result = await processPendingSessionDelivery({
        entry: currentEntry,
        context,
        beforeDelivery,
        onFailed,
      });
      if (result.status === "max-retries") {
        summary.skippedMaxRetries += 1;
        return "continue";
      }
      if (result.status === "backoff") {
        summary.deferredBackoff += 1;
        return "continue";
      }
      if (result.status === "stop") {
        return "stop";
      }
      if (result.status === "recovered" && result.finalized) {
        summary.recovered += 1;
        opts.log.info(`Recovered session delivery ${currentEntry.id}`);
      }
      return "continue";
    },
  });

  return summary;
}
