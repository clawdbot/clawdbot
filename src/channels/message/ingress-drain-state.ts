import type { ChannelIngressQueueClaim, ChannelIngressQueueRecord } from "./ingress-queue.js";

export class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

export type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "settled";
  occupiesLane: boolean;
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  stallWatchdogRetired: boolean;
  closeProcessingClaim: () => void;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
  isSettling: () => boolean;
};

export function createIngressSettleOwner(onSettled: () => void): {
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
  isSettling: () => boolean;
} {
  let settlePromise: Promise<void> | undefined;
  let settled = false;
  const settleOnce = async (fn: () => Promise<void>) => {
    if (settled) {
      return;
    }
    if (settlePromise) {
      await settlePromise;
      return;
    }
    // Publish ownership before the writer can synchronously reenter a lifecycle callback.
    settlePromise = Promise.resolve().then(async () => {
      // Only mark settled after the tombstone/fail/release write commits.
      // Write failure must keep heartbeat + in-memory ownership (wedged > duplicated).
      await fn();
      settled = true;
      onSettled();
    });
    try {
      await settlePromise;
    } catch (err) {
      settlePromise = undefined;
      throw err;
    }
  };
  return { settleOnce, isSettling: () => settlePromise !== undefined && !settled };
}

export function activeClaimKey<TPayload, TMetadata>(
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
): string {
  return `${claim.id}\0${claim.claim.token}`;
}

export function resolveLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean,
): string {
  const derivedLaneKey = deriveLaneKey?.(record);
  const storedLaneKey = record.laneKey;
  if (
    !reconcileStoredLaneKey ||
    storedLaneKey === undefined ||
    derivedLaneKey === undefined ||
    storedLaneKey === derivedLaneKey
  ) {
    return derivedLaneKey ?? storedLaneKey ?? record.id;
  }
  return reconcileStoredLaneKey(record, storedLaneKey, derivedLaneKey)
    ? derivedLaneKey
    : storedLaneKey;
}

export function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted((a, b) => a.localeCompare(b));
}
