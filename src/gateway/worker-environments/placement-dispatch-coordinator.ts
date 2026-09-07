import { isDeepStrictEqual } from "node:util";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementCancellationTarget } from "./placement-reclaim-contract.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchAdmission,
} from "./service-contract.js";

function trackPlacementOperation<T extends WorkerDispatchPlacement | void>(
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
      if (placement) {
        record(placement);
        completed = current;
      }
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
  type PlacementFence = { promise: Promise<void>; dispatchCohort: readonly symbol[] };
  type ReconciliationSweep = PlacementFence & {
    predecessor: PlacementFence | undefined;
    full: boolean;
    acceptingJoins: boolean;
    joinedRecoveries: Set<Promise<void>>;
  };
  const activeDispatches = new Set<symbol>();
  let placementFence: PlacementFence | undefined;
  // A sweep can join an environment pass that began before the sweep. Keep its predecessor
  // separate from the fence tail so recovery waits for older exclusive work, never the sweep
  // it completes or exclusive work queued behind that sweep.
  const reconciliationSweeps = new Set<ReconciliationSweep>();
  const dispatchIdleWaiters = new Set<() => void>();
  const waitForDispatchIdle = (): Promise<void> => {
    if (activeDispatches.size === 0) {
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
      dispatchCohort: predecessor?.dispatchCohort ?? [...activeDispatches],
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
    joinsActiveDispatch = false,
  ): Promise<T> => {
    const predecessor = placementFence;
    const ready = (async () => {
      if (predecessor) {
        await predecessor.promise.catch(() => undefined);
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
    const exclusive: PlacementFence = {
      promise: barrier,
      dispatchCohort: joinsActiveDispatch
        ? (predecessor?.dispatchCohort ?? [...activeDispatches])
        : [],
    };
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
      // Only the original dispatch cohort keeps maintenance admission open. Later joins
      // cannot extend it indefinitely, and hard predecessors carry an empty cohort.
      if (!pendingFence || pendingFence.dispatchCohort.some((id) => activeDispatches.has(id))) {
        break;
      }
      await racePromiseWithAbortSignal(
        pendingFence.promise.catch(() => undefined),
        signal,
      );
    }
    const operationId = Symbol("dispatch");
    activeDispatches.add(operationId);
    try {
      return await operation();
    } finally {
      activeDispatches.delete(operationId);
      if (activeDispatches.size === 0) {
        const waiters = [...dispatchIdleWaiters];
        dispatchIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  };
  type OperationServices = Pick<WorkerPlacementDispatchService, "dispatch" | "move" | "reclaim"> & {
    recovery: WorkerPlacementDispatchService["resumeProvisioning"];
  };
  type PlacementOperation = {
    [Kind in keyof OperationServices]: {
      kind: Kind;
      request: Parameters<OperationServices[Kind]>[0];
    } & ReturnType<typeof trackPlacementOperation<Awaited<ReturnType<OperationServices[Kind]>>>>;
  }[keyof OperationServices];
  const operationsInFlight = new Map<string, Set<PlacementOperation>>();
  const pendingOperations = (sessionId: string) => [...(operationsInFlight.get(sessionId) ?? [])];
  const registerOperation = (record: PlacementOperation) => {
    const pending = operationsInFlight.get(record.request.sessionId) ?? new Set();
    pending.add(record);
    operationsInFlight.set(record.request.sessionId, pending);
    const release = () => {
      pending.delete(record);
      if (pending.size === 0) {
        operationsInFlight.delete(record.request.sessionId);
      }
    };
    void record.operation.then(release, release);
  };
  const joinOperation = async <T>(operation: Promise<T>, authorize?: () => void): Promise<T> => {
    // Shared placement work must never inherit another caller's authority across an await.
    authorize?.();
    const result = await operation;
    authorize?.();
    return result;
  };
  return {
    isPlacementOperationInFlight: (sessionId) => operationsInFlight.has(sessionId),
    dispatch: async (request, onTransition, authorize) => {
      const inFlight = pendingOperations(request.sessionId).find(
        (pending) => pending.kind === "dispatch",
      );
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already dispatching another request`);
        }
        return await joinOperation(inFlight.operation, authorize);
      }
      // Capture predecessors before admission yields. A later Stop awaits this operation
      // and must never become a predecessor of the dispatch it is cancelling.
      const predecessors = pendingOperations(request.sessionId).filter(
        (pending) => pending.kind === "reclaim",
      );
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
      registerOperation({ kind: "dispatch", request, ...tracked });
      return await operation;
    },
    forceDestroyEnvironment: (environmentId, onCleanupError) =>
      runExclusivePlacementOperation(() =>
        service.forceDestroyEnvironment(environmentId, onCleanupError),
      ),
    move: async (request, onTransition, authorize) => {
      const inFlight = pendingOperations(request.sessionId).find(
        (pending) => pending.kind === "move",
      );
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already moving to another target`);
        }
        return await joinOperation(inFlight.operation, authorize);
      }
      const predecessors = pendingOperations(request.sessionId).filter(
        (pending) => pending.kind === "reclaim",
      );
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
      registerOperation({ kind: "move", request, ...tracked });
      return await operation;
    },
    reclaim: async (request, authorize, beforeDrain) => {
      // Cancellation may need coordinated recovery. Reserve exclusivity only after it drains.
      // Retain only predecessors: later dispatches wait for these Stops and cannot become
      // work a Stop awaits. Each caller still revalidates its own lifecycle and authority.
      const operations = pendingOperations(request.sessionId).filter(
        (operation) =>
          operation.request.sessionKey === request.sessionKey &&
          operation.request.agentId === request.agentId,
      );
      const hasPendingDispatch = () =>
        operations.some(
          (operation) =>
            operation.kind !== "reclaim" &&
            operationsInFlight.get(request.sessionId)?.has(operation),
        );
      const isPending = () =>
        operations.some((operation) => operationsInFlight.get(request.sessionId)?.has(operation));
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
      registerOperation({ kind: "reclaim", request, ...tracked });
      return await operation;
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
      const ready = createDeferredCore();
      const foreground =
        createDeferredCore<
          Awaited<ReturnType<WorkerPlacementDispatchService["resumeProvisioning"]>>
        >();
      let providerSettlement = Promise.resolve();
      // Reserve the queue in this stack, before admission can yield to a newer sweep.
      // Only foreground recovery holds that fence; a timed-out provider retains admission.
      const recover = async () => {
        ready.resolve();
        await foreground.promise;
      };
      let queued: Promise<void>;
      if (sweep) {
        queued = (async () => {
          if (sweep.predecessor) {
            await sweep.predecessor.promise.catch(() => undefined);
          }
          // Recovery waits for every admitted dispatch and older exclusive operation,
          // including later dispatches admitted while the original cohort was active.
          await waitForDispatchIdle();
          await recover();
        })();
        sweep.joinedRecoveries.add(queued);
      } else {
        queued = runExclusivePlacementOperation(recover, undefined, true);
      }
      void queued.catch(ready.reject);
      const tracked = trackPlacementOperation(async (report) => {
        try {
          // Recovery joins its captured sweep, never a later Stop which awaits that sweep.
          const result = await service.resumeProvisioning(
            placement,
            async (signal) => {
              await reconcileEnvironmentCore(signal, (settled) => {
                providerSettlement = settled;
              });
            },
            report,
            (runRecovery) =>
              admitDispatch(placement, async (signal) => {
                try {
                  await racePromiseWithAbortSignal(ready.promise, signal);
                  signal?.throwIfAborted();
                  const recovered = await runRecovery(signal);
                  foreground.resolve(recovered);
                  return recovered;
                } catch (error) {
                  foreground.reject(error);
                  throw error;
                } finally {
                  // Caller timeouts finish the sweep, not the real provider or its Stop owner.
                  await providerSettlement;
                }
              }).catch(async (error: unknown) => {
                if (error instanceof WorkerPlacementAdmissionTargetError) {
                  // The failed reservation is released. Cleanup still follows its captured
                  // predecessor, never a later Stop or the sweep that this recovery joins.
                  await ready.promise;
                }
                throw error;
              }),
          );
          // Never-admitted invalid owners still settle their exact cleanup before returning.
          foreground.resolve(result);
          return result;
        } catch (error) {
          foreground.reject(error);
          throw error;
        }
      });
      registerOperation({ kind: "recovery", request: placement, ...tracked });
      return foreground.promise;
    },
  };
}
