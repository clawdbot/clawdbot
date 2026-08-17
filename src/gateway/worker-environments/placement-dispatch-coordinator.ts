import { isDeepStrictEqual } from "node:util";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

/** Serializes reconciliation sweeps against dispatches and deduplicates exact requests. */
export function coordinateWorkerPlacementDispatch(
  service: WorkerPlacementDispatchService,
): WorkerPlacementDispatchService {
  let activeDispatchCount = 0;
  let reconciliation: Promise<void> | undefined;
  const dispatchIdleWaiters = new Set<() => void>();
  const waitForDispatchIdle = (): Promise<void> => {
    if (activeDispatchCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      dispatchIdleWaiters.add(resolve);
    });
  };
  const runReconciliation = (operation: () => Promise<void>): Promise<void> => {
    if (reconciliation) {
      return reconciliation;
    }
    const current = (async () => {
      await waitForDispatchIdle();
      await operation();
    })();
    reconciliation = current;
    const clearCurrent = () => {
      if (reconciliation === current) {
        reconciliation = undefined;
      }
    };
    void current.then(clearCurrent, clearCurrent);
    return current;
  };
  const runExclusivePlacementOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = (async () => {
      const pendingReconciliation = reconciliation;
      if (pendingReconciliation) {
        await pendingReconciliation.catch(() => undefined);
      }
      await waitForDispatchIdle();
      return await operation();
    })();
    const barrier = current.then(
      () => undefined,
      () => undefined,
    );
    reconciliation = barrier;
    return current.finally(() => {
      if (reconciliation === barrier) {
        reconciliation = undefined;
      }
    });
  };
  const runPlacementOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      const pendingReconciliation = reconciliation;
      if (!pendingReconciliation) {
        break;
      }
      await pendingReconciliation.catch(() => undefined);
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
  return {
    dispatch: async (request, onTransition) => {
      const inFlight = dispatchInFlight.get(request.sessionId);
      if (inFlight) {
        if (
          inFlight.request.sessionKey !== request.sessionKey ||
          inFlight.request.agentId !== request.agentId ||
          inFlight.request.profileId !== request.profileId ||
          inFlight.request.executionMode !== request.executionMode ||
          inFlight.request.idempotencyKey !== request.idempotencyKey ||
          inFlight.request.deviceId !== request.deviceId ||
          inFlight.request.machineClass !== request.machineClass ||
          !isDeepStrictEqual(inFlight.request.inheritedProfile, request.inheritedProfile)
        ) {
          throw new Error(`Session ${request.sessionKey} is already dispatching another request`);
        }
        return await inFlight.operation;
      }
      const operation = runPlacementOperation(() => service.dispatch(request, onTransition));
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
    move: async (request, onTransition) => {
      const inFlight = moveInFlight.get(request.sessionId);
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already moving to another target`);
        }
        return await inFlight.operation;
      }
      const operation = runExclusivePlacementOperation(() => service.move(request, onTransition));
      moveInFlight.set(request.sessionId, { request, operation });
      try {
        return await operation;
      } finally {
        if (moveInFlight.get(request.sessionId)?.operation === operation) {
          moveInFlight.delete(request.sessionId);
        }
      }
    },
    reclaim: async (request) => await runPlacementOperation(() => service.reclaim(request)),
    reconcile: () => runReconciliation(service.reconcile),
    reconcileActive: (environmentId) =>
      environmentId === undefined
        ? runReconciliation(() => service.reconcileActive())
        : runExclusivePlacementOperation(() => service.reconcileActive(environmentId)),
  };
}
