import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  loadDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import { generateSecureUuid } from "./secure-random.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type PlatformClaimParams = {
  queueName: string;
  id: string;
  stateDir?: string;
  requiresProducerClaim?: boolean;
  reconciledPlatformSendAttemptId?: string;
  reconciledPlatformSendStartedAt?: number;
};

export const PLATFORM_SEND_OWNER_LEASE_MS = 30_000;

/** Creates the owner published atomically with an immediate live delivery. */
export function createInitialDeliveryProducerClaim(now = Date.now()) {
  return {
    requiresProducerClaim: true,
    availableAt: now + PLATFORM_SEND_OWNER_LEASE_MS,
    producerClaimId: generateSecureUuid(),
    recoveryState: "producer_claimed",
  } as const;
}

export type InitialDeliveryProducerClaim = ReturnType<typeof createInitialDeliveryProducerClaim>;

/** Runs an existing queue mutation only while its exact platform owner survives. */
export function transitionOwnedDeliveryQueueEntry(
  params: {
    queueName: string;
    id: string;
    stateDir?: string;
    platformSendAttemptId: string | null;
  },
  transition: (entry: DeliveryQueueEntryState) => void,
): boolean {
  const database = openOpenClawStateDatabase({
    env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
  });
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const entry = loadDeliveryQueueEntry(params.queueName, params.id, params.stateDir);
      if (!entry) {
        return false;
      }
      if (
        params.platformSendAttemptId === null
          ? entry.platformSendAttemptId !== undefined || entry.producerClaimId !== undefined
          : entry.platformSendAttemptId !== params.platformSendAttemptId &&
            entry.producerClaimId !== params.platformSendAttemptId
      ) {
        return false;
      }
      transition(entry);
      return true;
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: `mutate owned ${params.queueName} delivery platform send`,
    },
  );
}

function transitionDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams,
  operation: "claim" | "promote" | "dispatch",
  transition: (entry: DeliveryQueueEntryState, now: number) => DeliveryQueueEntryState | undefined,
): boolean {
  // State-database opens reuse the canonical path-owned connection, so both
  // existing queue primitives execute inside this same IMMEDIATE transaction.
  const database = openOpenClawStateDatabase({
    env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
  });
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const current = loadDeliveryQueueEntry(params.queueName, params.id, params.stateDir);
      if (!current) {
        return false;
      }
      if (
        current.platformSendStartedAt !== undefined &&
        (operation === "promote" ||
          (operation === "claim" &&
            (current.platformSendStartedAt !== params.reconciledPlatformSendStartedAt ||
              current.platformSendAttemptId !== params.reconciledPlatformSendAttemptId ||
              typeof current.platformSendAttemptId !== "string")))
      ) {
        return false;
      }
      const updated = transition(current, Date.now());
      return updated
        ? upsertDeliveryQueueEntry({
            queueName: params.queueName,
            entry: updated,
            stateDir: params.stateDir,
            updatePendingOnly: true,
          })
        : false;
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: `${operation} ${params.queueName} delivery platform send`,
    },
  );
}

/** Claim a recoverable producer lease before any provider invocation. */
export function claimDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams,
): string | undefined {
  const claimId = generateSecureUuid();
  return transitionDeliveryQueueEntryPlatformSend(params, "claim", (entry, now) => {
    const reconciledNotSent =
      entry.recoveryState === "send_attempt_started" &&
      typeof params.reconciledPlatformSendStartedAt === "number" &&
      entry.platformSendStartedAt === params.reconciledPlatformSendStartedAt &&
      typeof params.reconciledPlatformSendAttemptId === "string" &&
      entry.platformSendAttemptId === params.reconciledPlatformSendAttemptId;
    if (
      entry.recoveryState &&
      !reconciledNotSent &&
      (entry.recoveryState !== "producer_claimed" ||
        typeof entry.availableAt !== "number" ||
        entry.availableAt > now)
    ) {
      return undefined;
    }
    return {
      ...entry,
      ...(params.requiresProducerClaim === true ? { requiresProducerClaim: true } : {}),
      availableAt: now + PLATFORM_SEND_OWNER_LEASE_MS,
      producerClaimId: claimId,
      platformSendAttemptId: undefined,
      platformSendStartedAt: undefined,
      recoveryState: "producer_claimed",
    };
  })
    ? claimId
    : undefined;
}

/** Renew only the exact unexpired producer that already owns the row. */
export function renewDeliveryQueueEntryPlatformSendLease(
  params: Pick<PlatformClaimParams, "queueName" | "id" | "stateDir"> & {
    claimId: string;
  },
): number | undefined {
  const database = openOpenClawStateDatabase({
    env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
  });
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const entry = loadDeliveryQueueEntry(params.queueName, params.id, params.stateDir);
      const now = Date.now();
      const exactOwner =
        entry?.recoveryState === "producer_claimed"
          ? entry.producerClaimId === params.claimId
          : (entry?.recoveryState === "send_attempt_started" ||
              entry?.recoveryState === "unknown_after_send") &&
            entry.platformSendAttemptId === params.claimId;
      if (
        !entry ||
        entry.requiresProducerClaim !== true ||
        !exactOwner ||
        typeof entry.availableAt !== "number" ||
        entry.availableAt <= now
      ) {
        return undefined;
      }
      const expiresAt = now + PLATFORM_SEND_OWNER_LEASE_MS;
      return upsertDeliveryQueueEntry({
        queueName: params.queueName,
        entry: { ...entry, availableAt: expiresAt },
        stateDir: params.stateDir,
        updatePendingOnly: true,
      })
        ? expiresAt
        : undefined;
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: `renew ${params.queueName} delivery platform send`,
    },
  );
}

/** Atomically fence the exact unexpired owner at the real provider boundary. */
export function promoteDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
): boolean {
  return transitionDeliveryQueueEntryPlatformSend(params, "promote", (entry, now) =>
    entry.recoveryState === "producer_claimed" &&
    entry.producerClaimId === params.claimId &&
    typeof entry.availableAt === "number" &&
    entry.availableAt > now
      ? {
          ...entry,
          // Only an explicitly leased owner keeps its cross-process fence;
          // legacy recovery must remain immediately eligible after a crash.
          availableAt:
            entry.requiresProducerClaim === true ? now + PLATFORM_SEND_OWNER_LEASE_MS : undefined,
          producerClaimId: undefined,
          platformSendAttemptId: params.claimId,
          platformSendStartedAt: now,
          ...(params.route && "replyToId" in params.route
            ? { effectiveReplyToId: params.route.replyToId ?? null }
            : {}),
          recoveryState: "send_attempt_started",
        }
      : undefined,
  );
}

/** Atomically authorize dispatch, promoting a producer claim into the active attempt. */
export function dispatchDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
): boolean {
  return transitionDeliveryQueueEntryPlatformSend(params, "dispatch", (entry, now) => {
    const producerOwned =
      entry.recoveryState === "producer_claimed" &&
      entry.producerClaimId === params.claimId &&
      typeof entry.availableAt === "number" &&
      entry.availableAt > now;
    const attemptOwned =
      (entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
      entry.platformSendAttemptId === params.claimId &&
      (entry.requiresProducerClaim !== true ||
        (typeof entry.availableAt === "number" && entry.availableAt > now));
    if (!producerOwned && !attemptOwned) {
      return undefined;
    }
    return {
      ...entry,
      // Exact reconciliation can skip pre-send promotion, so publish attempt identity
      // atomically; later batch dispatches retain stronger unknown-after-send evidence.
      availableAt:
        entry.requiresProducerClaim === true
          ? producerOwned
            ? now + PLATFORM_SEND_OWNER_LEASE_MS
            : entry.availableAt
          : undefined,
      producerClaimId: undefined,
      platformSendAttemptId: params.claimId,
      platformSendStartedAt: now,
      ...(params.route && "replyToId" in params.route
        ? { effectiveReplyToId: params.route.replyToId ?? null }
        : {}),
      recoveryState:
        entry.recoveryState === "unknown_after_send"
          ? "unknown_after_send"
          : "send_attempt_started",
    };
  });
}
