import { isDeepStrictEqual } from "node:util";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

/** Serializes reconciliation sweeps against dispatches and deduplicates exact requests. */
export function coordinateWorkerPlacementDispatch(
  service: WorkerPlacementDispatchService,
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
  const runExclusivePlacementOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = (async () => {
      const pendingFence = placementFence;
      if (pendingFence) {
        await pendingFence.promise.catch(() => undefined);
      }
      await waitForDispatchIdle();
      return await operation();
    })();
    const barrier = current.then(
      () => undefined,
      () => undefined,
    );
    const exclusive: PlacementFence = { promise: barrier };
    placementFence = exclusive;
    return current.finally(() => {
      if (placementFence === exclusive) {
        placementFence = undefined;
      }
    });
  };
  const runPlacementOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      const pendingFence = placementFence;
      if (!pendingFence) {
        break;
      }
      await pendingFence.promise.catch(() => undefined);
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
    }
  >();
  const moveInFlight = new Map<
    string,
    {
      request: Parameters<WorkerPlacementDispatchService["move"]>[0];
      operation: ReturnType<WorkerPlacementDispatchService["move"]>;
    }
  >();
  const reclaimsInFlight = new Map<string, Set<Promise<unknown>>>();
  const afterSessionReclaims = async <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    // Later caller mutations cannot replace the worker while Stop prepares. Recovery
    // bypasses this session intent so it can release the very run Stop is draining.
    while (reclaimsInFlight.has(sessionId)) {
      await Promise.allSettled(reclaimsInFlight.get(sessionId)!);
    }
    return await run();
  };
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
      const operation = afterSessionReclaims(request.sessionId, () =>
        runPlacementOperation(() => service.dispatch(request, onTransition, authorize)),
      );
      dispatchInFlight.set(request.sessionId, { request, operation });
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
      const operation = afterSessionReclaims(request.sessionId, () =>
        runExclusivePlacementOperation(() => service.move(request, onTransition, authorize)),
      );
      moveInFlight.set(request.sessionId, { request, operation });
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
      const operation = service.reclaim(
        request,
        authorize,
        beforeDrain,
        runExclusivePlacementOperation,
      );
      const pending = reclaimsInFlight.get(request.sessionId) ?? new Set();
      pending.add(operation);
      reclaimsInFlight.set(request.sessionId, pending);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
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
