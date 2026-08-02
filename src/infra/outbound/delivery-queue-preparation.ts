// Fences stable outbound policy preparation across Gateway processes without
// persisting payload content or modifying-hook context.
import { randomUUID } from "node:crypto";
import {
  completePendingDeliveryQueueEntry,
  replacePendingDeliveryQueueEntry,
  upsertDeliveryQueueEntryOnceAcrossNamespaces,
} from "../delivery-queue-sqlite-namespace.js";
import {
  failPendingDeliveryQueueEntry,
  loadDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

const STABLE_PREPARATION_LEASE_MS = 5 * 60_000;
const STABLE_PREPARATION_LEASE_RENEW_MS = 30_000;

export type StableDeliveryPreparation = DeliveryQueueEntryState & {
  preparationState: "claimed" | "modifiers_started" | "prepared";
  preparationOwnerId?: string;
  preparationLeaseExpiresAt?: number;
};

export type StableDeliveryPreparationOwner = {
  current: () => StableDeliveryPreparation;
  beforeFirstModifier: () => void;
  markPrepared: () => void;
  markPublished: () => void;
};

export class StableDeliveryPreparationLostError extends Error {
  constructor(id: string) {
    super(`Stable outbound preparation ownership was lost: ${id}`);
    this.name = "StableDeliveryPreparationLostError";
  }
}

const STABLE_PREPARATION_CONFLICT_QUEUES = [
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
] as const;

function createStablePreparation(
  id: string,
  ownerId: string,
  now = Date.now(),
): StableDeliveryPreparation {
  return {
    id,
    enqueuedAt: now,
    retryCount: 0,
    attemptCount: 0,
    preparationState: "claimed",
    preparationOwnerId: ownerId,
    preparationLeaseExpiresAt: now + STABLE_PREPARATION_LEASE_MS,
  };
}

function failStablePreparation(
  entry: StableDeliveryPreparation,
  error: string,
  stateDir?: string,
): void {
  failPendingDeliveryQueueEntry({
    queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
    id: entry.id,
    expectedStatus: "pending",
    lastError: error,
    entry,
    // Policy may already have produced external side effects. Retain only a
    // payload-free terminal fence so a later producer cannot rerun it.
    failedEntry: {
      id: entry.id,
      enqueuedAt: entry.enqueuedAt,
      retryCount: entry.retryCount,
      attemptCount: entry.attemptCount,
    },
    stateDir,
  });
}

function claimStablePreparation(
  id: string,
  stateDir?: string,
): { status: "claimed"; entry: StableDeliveryPreparation } | { status: "existing" } {
  const ownerId = randomUUID();
  const proposed = createStablePreparation(id, ownerId);
  if (
    upsertDeliveryQueueEntryOnceAcrossNamespaces({
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      conflictQueueNames: STABLE_PREPARATION_CONFLICT_QUEUES,
      entry: proposed,
      stateDir,
    })
  ) {
    return { status: "claimed", entry: proposed };
  }

  const current = loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
    id,
    stateDir,
  ) as StableDeliveryPreparation | null;
  if (!current) {
    return { status: "existing" };
  }
  if ((current.preparationLeaseExpiresAt ?? 0) > Date.now()) {
    return { status: "existing" };
  }
  if (current.preparationState !== "claimed") {
    failStablePreparation(current, "stable outbound preparation was interrupted", stateDir);
    return { status: "existing" };
  }
  const reclaimed = createStablePreparation(id, ownerId);
  return replacePendingDeliveryQueueEntry({
    queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
    expectedEntry: current,
    replacementEntry: reclaimed,
    stateDir,
  })
    ? { status: "claimed", entry: reclaimed }
    : { status: "existing" };
}

export async function withStableDeliveryPreparation<T>(params: {
  id: string;
  stateDir?: string;
  run: (owner: StableDeliveryPreparationOwner) => Promise<T>;
}): Promise<{ status: "claimed"; value: T } | { status: "existing" }> {
  const claim = claimStablePreparation(params.id, params.stateDir);
  if (claim.status === "existing") {
    return claim;
  }

  let entry = claim.entry;
  let leaseLost = false;
  let published = false;
  const replaceEntry = (next: StableDeliveryPreparation): void => {
    if (
      leaseLost ||
      !replacePendingDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        expectedEntry: entry,
        replacementEntry: next,
        stateDir: params.stateDir,
      })
    ) {
      leaseLost = true;
      throw new StableDeliveryPreparationLostError(params.id);
    }
    entry = next;
  };
  const renewLease = (): void => {
    try {
      replaceEntry({
        ...entry,
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      });
    } catch {
      leaseLost = true;
    }
  };
  const leaseTimer = setInterval(renewLease, STABLE_PREPARATION_LEASE_RENEW_MS);
  leaseTimer.unref();
  const owner: StableDeliveryPreparationOwner = {
    current: () => entry,
    beforeFirstModifier: () => {
      replaceEntry({
        ...entry,
        preparationState: "modifiers_started",
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      });
    },
    markPrepared: () => {
      replaceEntry({
        ...entry,
        preparationState: "prepared",
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      });
    },
    markPublished: () => {
      published = true;
    },
  };

  try {
    const value = await params.run(owner);
    if (
      !published &&
      !completePendingDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        expectedEntry: entry,
        stateDir: params.stateDir,
      })
    ) {
      throw new Error(`Stable outbound preparation could not be settled: ${params.id}`);
    }
    return { status: "claimed", value };
  } catch (error) {
    if (!published && !leaseLost) {
      if (entry.preparationState === "claimed") {
        const released: StableDeliveryPreparation = {
          ...entry,
          preparationOwnerId: undefined,
          preparationLeaseExpiresAt: 0,
        };
        replacePendingDeliveryQueueEntry({
          queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          expectedEntry: entry,
          replacementEntry: released,
          stateDir: params.stateDir,
        });
      } else {
        failStablePreparation(entry, "stable outbound preparation failed", params.stateDir);
      }
    }
    throw error;
  } finally {
    clearInterval(leaseTimer);
  }
}
