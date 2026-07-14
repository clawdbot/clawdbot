import {
  installSessionPlacementAdmissionProvider,
  installSessionPlacementResetGuard,
} from "../agents/session-placement-admission.js";
import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { formatErrorMessage } from "../infra/errors.js";
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
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";

const WORKER_PLACEMENT_RECONCILE_INTERVAL_MS = 60_000;

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
  return {
    dispatch: async (request) => {
      for (;;) {
        const pendingReconciliation = reconciliation;
        if (!pendingReconciliation) {
          break;
        }
        await pendingReconciliation.catch(() => undefined);
      }
      activeDispatchCount += 1;
      try {
        return await service.dispatch(request);
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
    },
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
  const dispatchService = coordinateWorkerPlacementDispatch(
    createWorkerPlacementDispatchService({
      placements: params.placements,
      environments: params.environments,
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
      resolveWorkspacePath: async ({ sessionId, sessionKey, agentId }) => {
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
        const sessionEntry = resolveFreshestSessionEntryFromStoreKeys(
          target.store,
          target.storeKeys,
        );
        const worktree = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
        if (
          sessionEntry?.sessionId !== sessionId ||
          !sessionEntry.worktree?.id ||
          !worktree ||
          worktree.id !== sessionEntry.worktree.id ||
          worktree.ownerId !== target.canonicalKey
        ) {
          throw new Error(
            `Session ${sessionKey} dispatch requires a session-owned managed worktree`,
          );
        }
        return worktree.path;
      },
    }),
  );
  const admissionProvider = createWorkerSessionTurnPlacementProvider({
    environments: params.environments,
    placements: params.placements,
    admitNewPlacements: params.admitNewPlacements,
  });
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
