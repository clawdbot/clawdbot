import { isDeepStrictEqual } from "node:util";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementCancellationTarget } from "./placement-reclaim-contract.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";

export type WorkerPlacementDispatchAdmission = <T>(
  request: Pick<WorkerPlacementDispatchRequest, "sessionId" | "sessionKey" | "agentId">,
  run: (signal?: AbortSignal) => Promise<T>,
  authorize?: () => void,
) => Promise<T>;

function trackPlacementOperation<T extends WorkerDispatchPlacement>(
  run: (report: (placement: WorkerDispatchPlacement) => void) => Promise<T>,
  onTransition?: (placement: WorkerDispatchPlacement) => void,
) {
  let current: WorkerPlacementCancellationTarget | undefined;
  let completed: WorkerPlacementCancellationTarget | undefined;
  const record = (placement: WorkerDispatchPlacement) => {
    // Retain the producer's authority by value before an observer can mutate its snapshot.
    current = {
      state: placement.state,
      generation: placement.generation,
      environmentId: placement.environmentId,
      activeOwnerEpoch: placement.activeOwnerEpoch,
    };
  };
  return {
    currentPlacement: () => current,
    completedPlacement: () => completed,
    operation: run((placement) => {
      record(placement);
      onTransition?.({ ...placement });
    }).then((placement) => {
      // Completion can outlive the map entry while Stop is loading cancellation support.
      record(placement);
      completed = current;
      return placement;
    }),
  };
}

/** Serializes reconciliation sweeps against dispatches and deduplicates exact requests. */
export function coordinateWorkerPlacementDispatch(
  service: WorkerPlacementDispatchService,
  admitDispatch: WorkerPlacementDispatchAdmission,
): WorkerPlacementDispatchService & {
  isPlacementOperationInFlight(sessionId: string): boolean;
} {
  type PlacementFence = { promise: Promise<void> };
  type ReconciliationSweep = PlacementFence & {
    predecessor: PlacementFence | undefined;
    full: boolean;
    acceptingJoins: boolean;
    joinedRecoveries: Set<Promise<void>>;
  };
  let activeDispatchCount = 0;
  let placementFence: PlacementFence | undefined;
  // A sweep can join an environment pass that began before the sweep. Keep its predecessor
  // separate from the fence tail so recovery waits for older exclusive work, never the sweep
  // it completes or exclusive work queued behind that sweep.
  const reconciliationSweeps = new Set<ReconciliationSweep>();
  const dispatchIdleWaiters = new Set<() => void>();
  const waitForDispatchIdle = (): Promise<void> => {
    if (activeDispatchCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      dispatchIdleWaiters.add(resolve);
    });
  };
  const runReconciliation = (operation: () => Promise<void>, full = true): Promise<void> => {
    const existing = full && [...reconciliationSweeps].find((sweep) => sweep.full);
    if (existing) {
      return existing.promise;
    }
    const predecessor = placementFence;
    const sweep: ReconciliationSweep = {
      predecessor,
      full,
      promise: Promise.resolve(),
      acceptingJoins: true,
      joinedRecoveries: new Set(),
    };
    const current = (async () => {
      try {
        if (predecessor) {
          await predecessor.promise.catch(() => undefined);
        }
        await waitForDispatchIdle();
        await operation();
      } finally {
        // Close admission before draining so late recoveries queue behind the existing fence.
        sweep.acceptingJoins = false;
        await Promise.allSettled(sweep.joinedRecoveries);
        reconciliationSweeps.delete(sweep);
        if (placementFence === sweep) {
          placementFence = undefined;
        }
      }
    })();
    sweep.promise = current;
    reconciliationSweeps.add(sweep);
    placementFence = sweep;
    return current;
  };
  const runExclusivePlacementOperation = <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const ready = (async () => {
      const pendingFence = placementFence;
      if (pendingFence) {
        await pendingFence.promise.catch(() => undefined);
      }
      await waitForDispatchIdle();
    })();
    const current = (async () => {
      await racePromiseWithAbortSignal(ready, signal);
      signal?.throwIfAborted();
      return await operation();
    })();
    // A canceled waiter releases its admission immediately, but its fence must still
    // carry older work forward so later requests cannot overtake the predecessor.
    const barrier = Promise.allSettled([ready, current]).then(() => undefined);
    const exclusive: PlacementFence = { promise: barrier };
    placementFence = exclusive;
    void barrier.then(() => {
      if (placementFence === exclusive) {
        placementFence = undefined;
      }
    });
    return current;
  };
  const runPlacementOperation = async <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    for (;;) {
      signal?.throwIfAborted();
      const pendingFence = placementFence;
      if (!pendingFence) {
        break;
      }
      await racePromiseWithAbortSignal(
        pendingFence.promise.catch(() => undefined),
        signal,
      );
    }
    activeDispatchCount += 1;
    try {
      return await operation();
    } finally {
      activeDispatchCount -= 1;
      if (activeDispatchCount === 0) {
        const waiters = [...dispatchIdleWaiters];
        dispatchIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  };
  const dispatchInFlight = new Map<
    string,
    {
      request: WorkerPlacementDispatchRequest;
      operation: ReturnType<WorkerPlacementDispatchService["dispatch"]>;
      currentPlacement: () => WorkerPlacementCancellationTarget | undefined;
      completedPlacement: () => WorkerPlacementCancellationTarget | undefined;
    }
  >();
  const moveInFlight = new Map<
    string,
    {
      request: Parameters<WorkerPlacementDispatchService["move"]>[0];
      operation: ReturnType<WorkerPlacementDispatchService["move"]>;
      currentPlacement: () => WorkerPlacementCancellationTarget | undefined;
      completedPlacement: () => WorkerPlacementCancellationTarget | undefined;
    }
  >();
  const reclaimsInFlight = new Map<
    string,
    Set<ReturnType<typeof trackPlacementOperation> & { request: WorkerPlacementReclaimRequest }>
  >();
  const joinOperation = async <T>(operation: Promise<T>, authorize?: () => void): Promise<T> => {
    // Shared placement work must never inherit another caller's authority across an await.
    authorize?.();
    const result = await operation;
    authorize?.();
    return result;
  };
  return {
    isPlacementOperationInFlight: (sessionId) =>
      dispatchInFlight.has(sessionId) ||
      moveInFlight.has(sessionId) ||
      reclaimsInFlight.has(sessionId),
    dispatch: async (request, onTransition, authorize) => {
      const inFlight = dispatchInFlight.get(request.sessionId);
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already dispatching another request`);
        }
        return await joinOperation(inFlight.operation, authorize);
      }
      // Capture predecessors before admission yields. A later Stop awaits this operation
      // and must never become a predecessor of the dispatch it is cancelling.
      const predecessors = [...(reclaimsInFlight.get(request.sessionId) ?? [])];
      const tracked = trackPlacementOperation(async (report) => {
        await Promise.allSettled(predecessors.map((pending) => pending.operation));
        return await admitDispatch(
          request,
          (signal) =>
            runPlacementOperation(
              () => service.dispatch(request, report, authorize, signal),
              signal,
            ),
          authorize,
        );
      }, onTransition);
      const { operation } = tracked;
      dispatchInFlight.set(request.sessionId, { request, ...tracked });
      try {
        return await operation;
      } finally {
        if (dispatchInFlight.get(request.sessionId)?.operation === operation) {
          dispatchInFlight.delete(request.sessionId);
        }
      }
    },
    forceDestroyEnvironment: (environmentId, onCleanupError) =>
      runExclusivePlacementOperation(() =>
        service.forceDestroyEnvironment(environmentId, onCleanupError),
      ),
    move: async (request, onTransition, authorize) => {
      const inFlight = moveInFlight.get(request.sessionId);
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already moving to another target`);
        }
        return await joinOperation(inFlight.operation, authorize);
      }
      const predecessors = [...(reclaimsInFlight.get(request.sessionId) ?? [])];
      const tracked = trackPlacementOperation(async (report) => {
        await Promise.allSettled(predecessors.map((pending) => pending.operation));
        return await admitDispatch(
          request,
          (signal) =>
            runExclusivePlacementOperation(
              () => service.move(request, report, authorize, signal),
              signal,
            ),
          authorize,
        );
      }, onTransition);
      const { operation } = tracked;
      moveInFlight.set(request.sessionId, { request, ...tracked });
      try {
        return await operation;
      } finally {
        if (moveInFlight.get(request.sessionId)?.operation === operation) {
          moveInFlight.delete(request.sessionId);
        }
      }
    },
    reclaim: async (request, authorize, beforeDrain) => {
      // Cancellation may need coordinated recovery. Reserve exclusivity only after it drains.
      // Retain only predecessors: later dispatches wait for these Stops and cannot become
      // work a Stop awaits. Each caller still revalidates its own lifecycle and authority.
      const predecessors = [...(reclaimsInFlight.get(request.sessionId) ?? [])];
      const operations = [
        dispatchInFlight.get(request.sessionId),
        moveInFlight.get(request.sessionId),
        ...predecessors,
      ].filter(
        (operation): operation is NonNullable<typeof operation> =>
          operation !== undefined &&
          operation.request.sessionKey === request.sessionKey &&
          operation.request.agentId === request.agentId,
      );
      const hasPendingDispatch = () =>
        operations.some(
          (operation) =>
            dispatchInFlight.get(request.sessionId) === operation ||
            moveInFlight.get(request.sessionId) === operation,
        );
      const isPending = () =>
        hasPendingDispatch() ||
        operations.some((operation) => reclaimsInFlight.get(request.sessionId)?.has(operation));
      // Generation increases within the lifecycle revalidated by the reclaim owner.
      // Dispatch, Move and predecessor Stop publish through the same transition owner.
      const latestPlacement = (read: "currentPlacement" | "completedPlacement") =>
        operations.reduce<WorkerPlacementCancellationTarget | undefined>((latest, pending) => {
          const current = pending[read]();
          return current && (!latest || current.generation > latest.generation) ? current : latest;
        }, undefined);
      const tracked = trackPlacementOperation((report) =>
        service.reclaim(
          request,
          authorize,
          beforeDrain,
          runExclusivePlacementOperation,
          operations.length
            ? {
                isCurrent: isPending,
                hasPendingDispatch,
                currentPlacement: () => latestPlacement("currentPlacement"),
                completedPlacement: () => latestPlacement("completedPlacement"),
                settled: Promise.allSettled(operations.map((pending) => pending.operation)),
              }
            : undefined,
          report,
        ),
      );
      const { operation } = tracked;
      const record = { request, ...tracked };
      const pending = reclaimsInFlight.get(request.sessionId) ?? new Set();
      pending.add(record);
      reclaimsInFlight.set(request.sessionId, pending);
      try {
        return await operation;
      } finally {
        pending.delete(record);
        if (pending.size === 0) {
          reclaimsInFlight.delete(request.sessionId);
        }
      }
    },
    reconcile: (mode) => runReconciliation(() => service.reconcile(mode)),
    reconcileActive: (environmentId) =>
      environmentId === undefined
        ? runReconciliation(() => service.reconcileActive())
        : runReconciliation(() => service.reconcileActive(environmentId), false),
    resumeProvisioning: (placement, reconcileEnvironmentCore) => {
      // Insertion order matters: a later queued sweep must not steal a provisioning join
      // from the earlier sweep already awaiting that environment pass.
      const sweep = [...reconciliationSweeps].find((candidate) => candidate.acceptingJoins);
      if (sweep) {
        const recovery = (async () => {
          if (sweep.predecessor) {
            await sweep.predecessor.promise.catch(() => undefined);
          }
          // The sweep fence blocks new dispatches. Its environment pass still joins only after
          // dispatches admitted before that fence and older exclusive work have drained.
          await waitForDispatchIdle();
          return await service.resumeProvisioning(placement, reconcileEnvironmentCore);
        })();
        sweep.joinedRecoveries.add(recovery);
        return recovery;
      }
      return runExclusivePlacementOperation(() =>
        service.resumeProvisioning(placement, reconcileEnvironmentCore),
      );
    },
  };
}
