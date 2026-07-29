import {
  installSessionPlacementAdmissionProvider,
  installSessionPlacementResetGuard,
} from "../agents/session-placement-admission.js";
import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  createWorkerPlacementDispatchService,
  type WorkerPlacementDispatchService,
} from "./worker-environments/placement-dispatch.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./worker-environments/placement-force-abandon.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createReclaimedPlacementRedispatch } from "./worker-environments/reclaimed-placement-redispatch.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./worker-environments/workspace-reconcile.js";
import { createWorkerWorkspaceConflictTranscriptHandlers } from "./worker-workspace-conflict-transcript.js";

const WORKER_PLACEMENT_RECONCILE_INTERVAL_MS = 60_000;
const workerPlacementLog = createSubsystemLogger("gateway/worker-placement");

const loadWorkerPlacementSessionRuntimeModule = createLazyRuntimeModule(async () => {
  const [placementSessionRuntime, { managedWorktrees }, sessionUtils] = await Promise.all([
    import("./worker-environments/placement-session-runtime.js"),
    import("../agents/worktrees/service.js"),
    import("./session-utils.js"),
  ]);
  return {
    isWorkerPlacementSessionRuntimeSupported:
      placementSessionRuntime.isWorkerPlacementSessionRuntimeSupported,
    managedWorktrees,
    resolveWorkerPlacementSessionRuntime:
      placementSessionRuntime.resolveWorkerPlacementSessionRuntime,
    resolveFreshestSessionEntryFromStoreKeys: sessionUtils.resolveFreshestSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetWithStore:
      sessionUtils.resolveGatewaySessionStoreTargetWithStore,
  };
});

class WorkerDispatchTargetChangedError extends Error {
  readonly code = "invalid_state";
}

/** Serializes reconciliation sweeps against in-flight dispatches so a sweep never
 * observes a placement mid-transition. Dispatches wait out any pending sweep. */
function coordinateWorkerPlacementDispatch(
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
  return {
    dispatch: async (request) => await runPlacementOperation(() => service.dispatch(request)),
    forceDestroyEnvironment: (environmentId, onCleanupError) =>
      runExclusivePlacementOperation(() =>
        service.forceDestroyEnvironment(environmentId, onCleanupError),
      ),
    reclaim: async (request) => await runPlacementOperation(() => service.reclaim(request)),
    reconcile: () => runReconciliation(service.reconcile),
    reconcileActive: () => runReconciliation(service.reconcileActive),
  };
}

type WorkerPlacementSidecar = { stop: () => Promise<void> };

export type GatewayWorkerPlacementRuntimeParams = {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  admitNewPlacements: boolean;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  warn: (message: string) => void;
};

export type GatewayWorkerPlacementRuntime = ReturnType<typeof createGatewayWorkerPlacementRuntime>;

export function createGatewayWorkerPlacementRuntime(params: GatewayWorkerPlacementRuntimeParams) {
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const workspaceConflictHandlers = createWorkerWorkspaceConflictTranscriptHandlers(
    loadWorkerPlacementSessionRuntimeModule,
  );
  const resolveWorkspacePath = async ({
    sessionId,
    sessionKey,
    agentId,
  }: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }): Promise<string> => {
    const {
      managedWorktrees,
      resolveFreshestSessionEntryFromStoreKeys,
      resolveGatewaySessionStoreTargetWithStore,
    } = await loadWorkerPlacementSessionRuntimeModule();
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
      clone: false,
    });
    const sessionEntry = resolveFreshestSessionEntryFromStoreKeys(target.store, target.storeKeys);
    const worktree = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
    if (
      sessionEntry?.sessionId !== sessionId ||
      !sessionEntry.worktree?.id ||
      !worktree ||
      worktree.id !== sessionEntry.worktree.id ||
      worktree.ownerId !== target.canonicalKey
    ) {
      throw new Error(`Session ${sessionKey} dispatch requires a session-owned managed worktree`);
    }
    return worktree.path;
  };
  const dispatchService = coordinateWorkerPlacementDispatch(
    createWorkerPlacementDispatchService({
      placements: params.placements,
      environments: params.environments,
      ...workspaceConflictHandlers,
      runLocalBarrier: async ({ sessionId, sessionKey, agentId, startDispatch }) => {
        const {
          isWorkerPlacementSessionRuntimeSupported,
          managedWorktrees,
          resolveFreshestSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
          resolveWorkerPlacementSessionRuntime,
        } = await loadWorkerPlacementSessionRuntimeModule();
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg: getRuntimeConfig(),
          key: sessionKey,
          agentId,
          clone: false,
        });
        const lifecycleIdentities = [
          sessionKey,
          target.canonicalKey,
          ...target.storeKeys,
          sessionId,
        ];
        let placement: ReturnType<typeof startDispatch> | undefined;
        await runExclusiveSessionLifecycleMutation({
          scope: target.storePath,
          identities: lifecycleIdentities,
          prepare: async () => {
            const currentConfig = getRuntimeConfig();
            const currentTarget = resolveGatewaySessionStoreTargetWithStore({
              cfg: currentConfig,
              key: sessionKey,
              agentId,
              clone: false,
            });
            const currentEntry = resolveFreshestSessionEntryFromStoreKeys(
              currentTarget.store,
              currentTarget.storeKeys,
            );
            const worktree = managedWorktrees.findLiveByOwner(
              "session",
              currentTarget.canonicalKey,
            );
            if (
              currentTarget.storePath !== target.storePath ||
              currentTarget.canonicalKey !== target.canonicalKey ||
              currentTarget.agentId !== target.agentId ||
              currentEntry?.sessionId !== sessionId ||
              !currentEntry.worktree?.id ||
              !worktree ||
              worktree.id !== currentEntry.worktree.id ||
              worktree.ownerId !== currentTarget.canonicalKey
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} changed before cloud worker dispatch. Retry.`,
              );
            }
            if (currentEntry.archivedAt !== undefined) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} was archived before cloud worker dispatch. Retry.`,
              );
            }
            const currentRuntime = resolveWorkerPlacementSessionRuntime({
              cfg: currentConfig,
              entry: currentEntry,
              agentId: currentTarget.agentId,
              sessionKey: currentTarget.canonicalKey,
            });
            if (!isWorkerPlacementSessionRuntimeSupported(currentRuntime)) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} runtime changed to ${currentRuntime} before cloud worker dispatch. Retry.`,
              );
            }
            placement = startDispatch();
            clearSessionQueues(lifecycleIdentities);
            params.revokeSessionAuthority({
              sessionId,
              sessionKeys: lifecycleIdentities,
            });
            const released = await interruptSessionWorkAdmissions({
              scope: target.storePath,
              identities: lifecycleIdentities,
              timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            });
            if (!released) {
              throw new Error(`Session ${sessionKey} is still active; dispatch stopped`);
            }
            await params.placements.waitForTurnClaimRelease(sessionId, {
              timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            });
            await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
              reentrant: true,
            });
          },
          run: async () => {
            if (!placement) {
              throw new Error(`Session ${sessionKey} dispatch barrier did not start`);
            }
          },
        });
        if (!placement) {
          throw new Error(`Session ${sessionKey} dispatch barrier did not complete`);
        }
        return placement;
      },
      runActivationBarrier: async ({ sessionId, sessionKey, agentId, activate }) => {
        const {
          isWorkerPlacementSessionRuntimeSupported,
          managedWorktrees,
          resolveFreshestSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
          resolveWorkerPlacementSessionRuntime,
        } = await loadWorkerPlacementSessionRuntimeModule();
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg: getRuntimeConfig(),
          key: sessionKey,
          agentId,
          clone: false,
        });
        const lifecycleIdentities = [
          sessionKey,
          target.canonicalKey,
          ...target.storeKeys,
          sessionId,
        ];
        let activePlacement: ReturnType<typeof activate> | undefined;
        await runExclusiveSessionLifecycleMutation({
          scope: target.storePath,
          identities: lifecycleIdentities,
          run: async () => {
            const currentConfig = getRuntimeConfig();
            const currentTarget = resolveGatewaySessionStoreTargetWithStore({
              cfg: currentConfig,
              key: sessionKey,
              agentId,
              clone: false,
            });
            const currentEntry = resolveFreshestSessionEntryFromStoreKeys(
              currentTarget.store,
              currentTarget.storeKeys,
            );
            const worktree = managedWorktrees.findLiveByOwner(
              "session",
              currentTarget.canonicalKey,
            );
            if (
              currentTarget.storePath !== target.storePath ||
              currentTarget.canonicalKey !== target.canonicalKey ||
              currentTarget.agentId !== target.agentId ||
              currentEntry?.sessionId !== sessionId ||
              !currentEntry.worktree?.id ||
              !worktree ||
              worktree.id !== currentEntry.worktree.id ||
              worktree.ownerId !== currentTarget.canonicalKey
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} changed before cloud worker activation. Retry.`,
              );
            }
            if (currentEntry.archivedAt !== undefined) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} was archived before cloud worker activation. Retry.`,
              );
            }
            const currentRuntime = resolveWorkerPlacementSessionRuntime({
              cfg: currentConfig,
              entry: currentEntry,
              agentId: currentTarget.agentId,
              sessionKey: currentTarget.canonicalKey,
            });
            if (!isWorkerPlacementSessionRuntimeSupported(currentRuntime)) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} runtime changed to ${currentRuntime} before cloud worker activation. Retry.`,
              );
            }
            activePlacement = activate();
          },
        });
        if (!activePlacement) {
          throw new Error(`Session ${sessionKey} activation barrier did not complete`);
        }
        return activePlacement;
      },
      runReclaimBarrier: async ({ sessionId, sessionKey, agentId, reclaim }) => {
        const {
          managedWorktrees,
          resolveFreshestSessionEntryFromStoreKeys,
          resolveGatewaySessionStoreTargetWithStore,
        } = await loadWorkerPlacementSessionRuntimeModule();
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg: getRuntimeConfig(),
          key: sessionKey,
          agentId,
          clone: false,
        });
        const lifecycleIdentities = [
          sessionKey,
          target.canonicalKey,
          ...target.storeKeys,
          sessionId,
        ];
        let worktreePath: string | undefined;
        let reclaimedPlacement: Awaited<ReturnType<typeof reclaim>> | undefined;
        await runExclusiveSessionLifecycleMutation({
          scope: target.storePath,
          identities: lifecycleIdentities,
          prepare: async () => {
            const currentTarget = resolveGatewaySessionStoreTargetWithStore({
              cfg: getRuntimeConfig(),
              key: sessionKey,
              agentId,
              clone: false,
            });
            const currentEntry = resolveFreshestSessionEntryFromStoreKeys(
              currentTarget.store,
              currentTarget.storeKeys,
            );
            const worktree = managedWorktrees.findLiveByOwner(
              "session",
              currentTarget.canonicalKey,
            );
            if (
              currentTarget.storePath !== target.storePath ||
              currentTarget.canonicalKey !== target.canonicalKey ||
              currentTarget.agentId !== target.agentId ||
              currentEntry?.sessionId !== sessionId ||
              !currentEntry.worktree?.id ||
              !worktree ||
              worktree.id !== currentEntry.worktree.id ||
              worktree.ownerId !== currentTarget.canonicalKey
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} changed before cloud worker stop. Retry.`,
              );
            }
            const placement = params.placements.get(sessionId);
            if (placement?.state !== "active" || placement.turnClaim) {
              throw new Error(
                `Session ${sessionKey} has active work; wait before stopping its cloud worker`,
              );
            }
            worktreePath = worktree.path;
            const released = await interruptSessionWorkAdmissions({
              scope: target.storePath,
              identities: lifecycleIdentities,
              timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            });
            if (!released) {
              throw new Error(`Session ${sessionKey} is still active; cloud worker stop cancelled`);
            }
            await params.placements.waitForTurnClaimRelease(sessionId, {
              timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
            });
            await runExclusiveSessionStoreWrite(target.storePath, async () => {}, {
              reentrant: true,
            });
          },
          run: async () => {
            if (!worktreePath) {
              throw new Error(`Session ${sessionKey} cloud worker stop barrier did not prepare`);
            }
            reclaimedPlacement = await reclaim(worktreePath);
            params.revokeSessionAuthority({ sessionId, sessionKeys: lifecycleIdentities });
          },
        });
        if (!reclaimedPlacement) {
          throw new Error(`Session ${sessionKey} cloud worker stop barrier did not complete`);
        }
        return reclaimedPlacement;
      },
      resolveWorkspacePath,
      workspaceOperations,
    }),
  );
  const admissionProvider = createWorkerSessionTurnPlacementProvider({
    environments: params.environments,
    placements: params.placements,
    admitNewPlacements: params.admitNewPlacements,
    resolveWorkspacePath,
    redispatchReclaimed: createReclaimedPlacementRedispatch({
      environments: params.environments,
      dispatch: dispatchService.dispatch,
    }),
    workspaceOperations,
  });
  const recoverPendingWorkspaceReconciliations = async (): Promise<void> => {
    const orphanedJournals = params.placements.pruneOrphanedWorkspaceReconciliations({
      retainFailedOwner: (recoveryError) =>
        recoveryError.startsWith(FORCED_WORKER_ABANDONMENT_ERROR),
    });
    for (const owner of orphanedJournals) {
      workerPlacementLog.warn(`discarded orphaned cloud workspace journal for ${owner.sessionId}`);
    }
    for (const owner of params.placements.listWorkspaceReconciliationOwners()) {
      try {
        const placement = params.placements.get(owner.sessionId);
        if (
          (placement?.state !== "active" && placement?.state !== "draining") ||
          placement.environmentId !== owner.environmentId ||
          placement.activeOwnerEpoch !== owner.ownerEpoch ||
          placement.generation !== owner.placementGeneration
        ) {
          throw new Error(`Cloud workspace journal has no matching owner: ${owner.sessionId}`);
        }
        const localPath = await resolveWorkspacePath({
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
        });
        const journal = params.placements.loadWorkspaceReconciliation(owner);
        if (!journal) {
          continue;
        }
        // Recover before placement/environment reconciliation can reclaim the
        // owner; otherwise a crashed partial apply loses its final repair path.
        await recoverWorkerWorkspaceReconciliation({ root: localPath, journal });
        params.placements.abortWorkspaceReconciliation(owner);
      } catch (error) {
        // A local edit can intentionally block rollback. Leave that journal
        // retryable for this session without withholding every cloud worker.
        workerPlacementLog.error(
          `cloud workspace recovery deferred for ${owner.sessionId}: ${formatErrorMessage(error)}`,
        );
      }
    }
  };
  const startRuntime = async (hooks: {
    isClosePreludeStarted: () => boolean;
    registerSidecar: (sidecar: WorkerPlacementSidecar) => void;
  }): Promise<WorkerPlacementSidecar | null> => {
    const uninstallPlacementAdmission = installSessionPlacementAdmissionProvider(admissionProvider);
    const uninstallPlacementResetGuard = installSessionPlacementResetGuard((sessionId) => {
      const placement = params.placements.get(sessionId);
      if (!placement || placement.state === "local") {
        return undefined;
      }
      return `cloud worker placement is ${placement.state}`;
    });
    let placementReconcileInterval: ReturnType<typeof setInterval> | undefined;
    let placementReconcileInFlight: Promise<void> | undefined;
    let stopped = false;
    const reconcileActivePlacements = (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (placementReconcileInFlight) {
        return placementReconcileInFlight;
      }
      const current = dispatchService.reconcileActive();
      placementReconcileInFlight = current;
      const clearCurrent = () => {
        if (placementReconcileInFlight === current) {
          placementReconcileInFlight = undefined;
        }
      };
      void current.then(clearCurrent, (error: unknown) => {
        params.warn(`Worker placement reconcile sweep failed: ${formatErrorMessage(error)}`);
        clearCurrent();
      });
      return current;
    };
    const sidecar: WorkerPlacementSidecar = {
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(placementReconcileInterval);
        placementReconcileInterval = undefined;
        uninstallPlacementAdmission();
        uninstallPlacementResetGuard();
        const environmentStop = params.environments.stop();
        const stopResults = await Promise.allSettled([
          ...(placementReconcileInFlight ? [placementReconcileInFlight] : []),
          environmentStop,
        ]);
        const environmentStopResult = stopResults.at(-1);
        if (environmentStopResult?.status === "rejected") {
          throw environmentStopResult.reason;
        }
      },
    };
    // Close must see the drain handle before reconciliation can yield.
    hooks.registerSidecar(sidecar);
    // Track startup reconciliation in the shared in-flight slot so a concurrent
    // close prelude drains it before uninstalling guards and stopping environments.
    const startupRecovery = recoverPendingWorkspaceReconciliations();
    placementReconcileInFlight = startupRecovery;
    try {
      await startupRecovery;
    } finally {
      if (placementReconcileInFlight === startupRecovery) {
        placementReconcileInFlight = undefined;
      }
    }
    if (hooks.isClosePreludeStarted()) {
      await sidecar.stop();
      return null;
    }
    const startupReconcile = dispatchService.reconcile();
    placementReconcileInFlight = startupReconcile;
    try {
      try {
        await startupReconcile;
      } finally {
        if (placementReconcileInFlight === startupReconcile) {
          placementReconcileInFlight = undefined;
        }
      }
      if (hooks.isClosePreludeStarted()) {
        await sidecar.stop();
        return null;
      }
      params.environments.start();
      placementReconcileInterval = setInterval(
        () => void reconcileActivePlacements(),
        WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
      );
      placementReconcileInterval.unref?.();
      return sidecar;
    } catch (error) {
      await sidecar.stop();
      throw error;
    }
  };
  return { dispatchService, admissionProvider, placements: params.placements, startRuntime };
}
