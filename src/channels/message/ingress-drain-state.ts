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

type IngressDispatchQuiescence = {
  task: Promise<void>;
  markDispatchSettled: () => void;
  markDeferred: () => void;
  markDeferredSettled: () => void;
};

/** Tracks the dispatcher and any deferred participant it registered. */
export function createIngressDispatchQuiescence(): IngressDispatchQuiescence {
  let dispatchSettled = false;
  let deferred = false;
  let deferredSettled = false;
  let resolved = false;
  let resolveTask!: () => void;
  const task = new Promise<void>((resolve) => {
    resolveTask = resolve;
  });
  const resolveIfQuiesced = () => {
    if (!resolved && dispatchSettled && !deferred) {
      resolved = true;
      resolveTask();
    }
  };
  return {
    task,
    markDispatchSettled: () => {
      dispatchSettled = true;
      resolveIfQuiesced();
    },
    markDeferred: () => {
      // A deferred participant can fail/settle before the dispatcher returns
      // "deferred" (debounced flushes). Settlement is sticky: re-arming here
      // would leave quiescence unresolvable and wedge the stall watchdog.
      if (!resolved && !deferredSettled) {
        deferred = true;
      }
    },
    markDeferredSettled: () => {
      deferredSettled = true;
      deferred = false;
      resolveIfQuiesced();
    },
  };
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
  /** Resolves only after the dispatcher and any registered deferred participant settle. */
  quiescence: IngressDispatchQuiescence;
  /** Watchdog-owned settlement, including a delayed post-fence release. */
  stallSettlementTask?: Promise<void>;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

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
