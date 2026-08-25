import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { clearSessionQueues } from "../auto-reply/reply/queue/cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../config/sessions/store-maintenance-preserve.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createGitHubPublicationRuntime } from "./github-publication-runtime.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { createGatewayWorkerPlacementChangePublisher } from "./server-worker-placement-change-events.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementMoveDestinationResolver } from "./server-worker-placement-move-destination.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import {
  resolveWorkerPlacementSessionTarget,
  runWorkerPlacementSessionBarrier,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import { createNodeWorkspaceRetainCoordinator } from "./worker-environments/node-workspace-retain-coordinator.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./worker-environments/placement-disk-space.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerDevicePlacementRequirementResolver } from "./worker-environments/placement-dispatch-startup.js";
import { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./worker-environments/placement-force-abandon.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "./worker-environments/placement-projector.js";
import { createPlacementSessionRetirement } from "./worker-environments/placement-session-retirement.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createReclaimedPlacementRedispatch } from "./worker-environments/reclaimed-placement-redispatch.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./worker-environments/session-placement-lifecycle.js";
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
    resolveWorkerPlacementExecutionMode:
      placementSessionRuntime.resolveWorkerPlacementExecutionMode,
    resolveWorkerPlacementCapabilities: placementSessionRuntime.resolveWorkerPlacementCapabilities,
    managedWorktrees,
    resolveWorkerPlacementSessionRuntime:
      placementSessionRuntime.resolveWorkerPlacementSessionRuntime,
    resolveCanonicalSessionEntryFromStoreKeys:
      sessionUtils.resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetWithStore:
      sessionUtils.resolveGatewaySessionStoreTargetWithStore,
  };
});

const loadWorkerWorkspacePreflight = createLazyRuntimeModule(async () => {
  const { preflightWorkerWorkspace } =
    await import("./worker-environments/workspace-sync-preflight.js");
  return preflightWorkerWorkspace;
});

type WorkerPlacementSidecar = { stop: () => Promise<void> };

export type GatewayWorkerPlacementRuntimeParams = {
  placements: WorkerSessionPlacementStore;
  environments: WorkerEnvironmentService;
  gatewayNamespace: string;
  persistAbandonedPartial?: (request: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    runId: string;
  }) => Promise<void>;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  warn: (message: string) => void;
};

export function createGatewayGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  warn: (message: string) => void;
}) {
  return createGitHubPublicationRuntime({
    placements: params.placements,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    warn: params.warn,
  });
}

export type GatewayWorkerPlacementRuntime = ReturnType<typeof createGatewayWorkerPlacementRuntime>;

export function createGatewayWorkerPlacementRuntime(
  params: GatewayWorkerPlacementRuntimeParams & {
    githubPublicationRuntime?: ReturnType<typeof createGitHubPublicationRuntime>;
  },
) {
  let nodeWorkerSupervisorTransport: NodeWorkerSupervisorTransport | undefined;
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const {
    coordinator: githubPublication,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    reconcilePublications,
  } = params.githubPublicationRuntime ??
  createGatewayGitHubPublicationRuntime({ placements: params.placements, warn: params.warn });
  const diskSpace = createWorkerPlacementDiskSpaceMonitor({
    placements: params.placements,
    environments: params.environments,
    warn: params.warn,
  });
  const workspaceConflictHandlers = createWorkerWorkspaceConflictTranscriptHandlers(
    loadWorkerPlacementSessionRuntimeModule,
  );
  const nodeWorkspaceRetention = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: params.gatewayNamespace,
    placements: params.placements,
    environments: params.environments,
    warn: params.warn,
  });
  const runnerAvailability = createWorkerPlacementRunnerAvailabilityReader({
    environments: params.environments,
    hasCurrentDeviceRunner: (deviceId) =>
      nodeWorkerSupervisorTransport?.hasCurrentRunner(deviceId) === true,
  });
  const reclaimBarriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: params.placements,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    revokeSessionAuthority: params.revokeSessionAuthority,
  });
  const runMoveBarrier = createGatewayWorkerPlacementMoveBarrier({
    placements: params.placements,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    persistAbandonedPartial: params.persistAbandonedPartial,
    revokeSessionAuthority: params.revokeSessionAuthority,
  });
  const resolveWorkspacePath = async ({
    sessionId,
    sessionKey,
    agentId,
  }: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }): Promise<string> => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const { worktree } = resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      sessionId,
      sessionKey,
      agentId,
      errorMessage: `Session ${sessionKey} dispatch requires a session-owned managed worktree`,
    });
    return worktree.path;
  };
  const resolveDevicePlacementRequirement: WorkerDevicePlacementRequirementResolver = async (
    identity,
  ) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const { config, target, entry } = resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before paired-device recovery`,
    });
    const runtime = sessionRuntime.resolveWorkerPlacementSessionRuntime({
      cfg: config,
      entry,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
    });
    const { executionMode, devicePlacement } =
      sessionRuntime.resolveWorkerPlacementCapabilities(runtime);
    if (executionMode !== identity.executionMode || !devicePlacement) {
      throw new Error(
        `runtime ${runtime} no longer supports this paired-device placement; select a compatible runtime or continue on the Gateway`,
      );
    }
    return devicePlacement;
  };
  const resolveNodeWorkspaceBinding = async (binding: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
  }) => {
    const placement = params.placements.get(binding.sessionId);
    if (
      !placement ||
      (placement.state !== "active" &&
        placement.state !== "draining" &&
        placement.state !== "reconciling") ||
      placement.environmentId !== binding.environmentId ||
      placement.activeOwnerEpoch !== binding.ownerEpoch
    ) {
      return undefined;
    }
    return {
      localPath: await resolveWorkspacePath({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      }),
      manifestRef: placement.workspaceBaseManifestRef,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
    };
  };
  const publishPlacementChanges = createGatewayWorkerPlacementChangePublisher(params);
  const rawDispatchService = coordinateWorkerPlacementDispatch(
    createWorkerPlacementDispatchService({
      placements: params.placements,
      environments: params.environments,
      runnerAvailability,
      resolveDevicePlacementRequirement,
      ...workspaceConflictHandlers,
      ...reclaimBarriers,
      runLocalBarrier: async ({
        sessionId,
        sessionKey,
        agentId,
        executionMode,
        authorize,
        startDispatch,
      }) => {
        const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
        const {
          resolveWorkerPlacementExecutionMode,
          resolveGatewaySessionStoreTargetWithStore,
          resolveWorkerPlacementSessionRuntime,
        } = sessionRuntime;
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
            const {
              config: currentConfig,
              target: currentTarget,
              entry: currentEntry,
              worktree,
            } = resolveWorkerPlacementSessionTarget({
              sessionRuntime,
              config: getRuntimeConfig(),
              sessionId,
              sessionKey,
              agentId,
              expectedTarget: target,
              errorMessage: `Session ${sessionKey} changed before cloud worker dispatch. Retry.`,
            });
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
            if (resolveWorkerPlacementExecutionMode(currentRuntime) !== executionMode) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} runtime changed to ${currentRuntime} before cloud worker dispatch. Retry.`,
              );
            }
            const preflightWorkerWorkspace = await loadWorkerWorkspacePreflight();
            await preflightWorkerWorkspace({ localPath: worktree.path });
            authorize?.();
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
      runActivationBarrier: async ({
        sessionId,
        sessionKey,
        agentId,
        executionMode,
        authorize,
        activate,
      }) =>
        await runWorkerPlacementSessionBarrier({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          getConfig: getRuntimeConfig,
          sessionId,
          sessionKey,
          agentId,
          executionMode,
          action: "activation",
          run: () => {
            authorize?.();
            return activate();
          },
        }),
      runRecoveryBarrier: async ({
        sessionId,
        sessionKey,
        agentId,
        executionMode,
        environmentId,
        expectedGeneration,
        run,
      }) =>
        await runWorkerPlacementSessionBarrier({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          getConfig: getRuntimeConfig,
          sessionId,
          sessionKey,
          agentId,
          executionMode,
          action: "recovery",
          run: async (worktree) => {
            const placement = params.placements.get(sessionId);
            if (
              placement?.state !== "provisioning" ||
              placement.generation !== expectedGeneration ||
              placement.environmentId !== environmentId
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${sessionKey} placement changed before cloud worker recovery. Retry.`,
              );
            }
            await run(worktree.path);
          },
        }),
      onActivated: (request) => {
        if (request.deviceId) {
          void nodeWorkspaceRetention.schedule(request.deviceId);
        }
      },
      runMoveBarrier,
      resolveMoveDestination: createGatewayWorkerPlacementMoveDestinationResolver({
        environments: params.environments,
        getConfig: getRuntimeConfig,
        loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      }),
      resolveWorkspacePath,
      workspaceOperations,
      prepareAcceptedWorkspacePublication,
      publishAcceptedWorkspace,
      resolveGitAuthor: (agentId) =>
        (
          resolveConfiguredGitHubToolIdentity({
            config: getRuntimeConfig(),
            agentId,
            scope: "agent",
          }) ??
          resolveConfiguredGitHubToolIdentity({
            config: getRuntimeConfig(),
            agentId,
            scope: "system",
          })
        )?.gitAuthor,
    }),
  );
  const dispatchService = {
    ...rawDispatchService,
    reconcile: (mode: Parameters<typeof rawDispatchService.reconcile>[0]) =>
      publishPlacementChanges(() => rawDispatchService.reconcile(mode)),
    reconcileActive: (environmentId?: string) =>
      publishPlacementChanges(() => rawDispatchService.reconcileActive(environmentId)),
  };
  const sessionRetirement = createPlacementSessionRetirement({
    placements: params.placements,
    environments: params.environments,
    forceDestroyEnvironment: dispatchService.forceDestroyEnvironment,
    createSessionEvidenceResolver: createWorkerPlacementSessionEvidenceResolver,
    warn: params.warn,
  });
  const admissionProvider = createWorkerSessionTurnPlacementProvider({
    environments: params.environments,
    placements: params.placements,
    resolveWorkspacePath,
    reconcileActivePlacement: async (environmentId) =>
      await dispatchService.reconcileActive(environmentId),
    redispatchReclaimed: createReclaimedPlacementRedispatch({
      environments: params.environments,
      dispatch: dispatchService.dispatch,
      resolveDevicePlacementRequirement,
    }),
    workspaceOperations,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
  });
  const recoverPendingWorkspaceReconciliations = async (): Promise<void> => {
    const orphanedJournals = params.placements.pruneOrphanedWorkspaceReconciliations({
      retainFailedOwner: (recoveryError) =>
        recoveryError.startsWith(FORCED_WORKER_ABANDONMENT_ERROR),
    });
    for (const owner of orphanedJournals) {
      workerPlacementLog.warn(`discarded orphaned cloud workspace journal for ${owner.sessionId}`);
    }
    const pendingBySession = new Map(
      params.placements
        .listPendingWorkspaceResults()
        .map((pending) => [pending.sessionId, pending] as const),
    );
    for (const owner of params.placements.listWorkspaceReconciliationOwners()) {
      try {
        const placement = params.placements.get(owner.sessionId);
        const pending = pendingBySession.get(owner.sessionId);
        const ownsCurrentGeneration = placement?.generation === owner.placementGeneration;
        const ownsDrainedPendingGeneration =
          placement?.state === "draining" &&
          placement.generation === owner.placementGeneration + 1 &&
          pending?.environmentId === owner.environmentId &&
          pending.ownerEpoch === owner.ownerEpoch &&
          pending.placementGeneration === owner.placementGeneration;
        if (
          (placement?.state !== "active" && placement?.state !== "draining") ||
          placement.environmentId !== owner.environmentId ||
          placement.activeOwnerEpoch !== owner.ownerEpoch ||
          (!ownsCurrentGeneration && !ownsDrainedPendingGeneration)
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
    unregisterSidecar: (sidecar: WorkerPlacementSidecar) => void;
  }): Promise<WorkerPlacementSidecar | null> => {
    if (hooks.isClosePreludeStarted()) {
      return null;
    }
    const uninstallPlacementAdmission = installSessionPlacementAdmissionProvider(admissionProvider);
    let placementReconcileInterval: ReturnType<typeof setInterval> | undefined;
    const placementReconcile = { current: undefined as Promise<void> | undefined };
    const diskSpaceSweep = { current: undefined as Promise<void> | undefined };
    let stopped = false;
    const uninstallEnvironmentReconcileGuard = installWorkerPlacementReconcileGuard({
      placements: params.placements,
      environments: params.environments,
      dispatch: dispatchService,
      isStopping: () => stopped,
    });
    // Session evidence must survive until its remote owner has been reclaimed or proven gone.
    const uninstallSessionMaintenancePreservation = registerSessionMaintenancePreserveKeysProvider(
      () =>
        params.placements.listForReconcile().flatMap((placement) =>
          placement.state === "failed" &&
          isFailedWorkerPlacementEnvironmentGone({
            environmentService: params.environments,
            placement,
          })
            ? []
            : [placement.sessionKey],
        ),
    );
    const trackOperation = (
      slot: { current: Promise<void> | undefined },
      current: Promise<void>,
      failureMessage: string,
    ): Promise<void> => {
      slot.current = current;
      const clearCurrent = () => {
        if (slot.current === current) {
          slot.current = undefined;
        }
      };
      void current.then(clearCurrent, (error: unknown) => {
        params.warn(`${failureMessage}: ${formatErrorMessage(error)}`);
        clearCurrent();
      });
      return current;
    };
    const reconcileActivePlacements = (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (placementReconcile.current) {
        return placementReconcile.current;
      }
      return trackOperation(
        placementReconcile,
        publishPlacementChanges(async () => {
          await sessionRetirement.reconcile();
          await rawDispatchService.reconcileActive();
          await reconcilePublications();
          void nodeWorkspaceRetention.schedule();
        }),
        "Worker placement reconcile sweep failed",
      );
    };
    const sweepDiskSpace = (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      if (diskSpaceSweep.current) {
        return diskSpaceSweep.current;
      }
      return trackOperation(diskSpaceSweep, diskSpace.sweep(), "Worker disk-space sweep failed");
    };
    const sweepActivePlacements = (): void => {
      void reconcileActivePlacements();
      // Session-lifetime sampling covers idle placements independently of provider health.
      void sweepDiskSpace();
    };
    const uninstallSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      const previousSessionId = mutation.previous.sessionId;
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (previousSessionId && previousSessionId !== currentSessionId) {
        const pending = placementReconcile.current;
        if (!pending) {
          void reconcileActivePlacements();
          return;
        }
        void pending.then(reconcileActivePlacements, reconcileActivePlacements);
      }
    });
    let stopPromise: Promise<void> | undefined;
    const sidecar: WorkerPlacementSidecar = {
      stop: () => {
        if (stopPromise) {
          return stopPromise;
        }
        if (!stopped) {
          stopped = true;
          // Cancel only enrollment: admitted recovery may still finish attaching before service stop.
          params.environments.stopNodeEnrollmentWaits?.();
          clearInterval(placementReconcileInterval);
          placementReconcileInterval = undefined;
          uninstallSessionIdentityMutation();
          uninstallSessionMaintenancePreservation();
          uninstallPlacementAdmission();
        }
        const currentStop = (async () => {
          await Promise.allSettled(
            [placementReconcile.current, diskSpaceSweep.current].filter(
              (operation): operation is Promise<void> => operation !== undefined,
            ),
          );
          await nodeWorkspaceRetention.stop();
          await params.environments.stop();
          await uninstallEnvironmentReconcileGuard();
        })();
        stopPromise = currentStop;
        void currentStop.catch(() => {
          if (stopPromise === currentStop) {
            stopPromise = undefined;
          }
        });
        return currentStop;
      },
    };
    // Close must see the drain handle before reconciliation can yield.
    hooks.registerSidecar(sidecar);
    const stopBeforeReady = async () => {
      await sidecar.stop();
      hooks.unregisterSidecar(sidecar);
      return null;
    };
    try {
      // Track startup reconciliation in the placement slot so a concurrent
      // close prelude drains it before uninstalling guards and stopping environments.
      const startupRecovery = recoverPendingWorkspaceReconciliations();
      placementReconcile.current = startupRecovery;
      try {
        await startupRecovery;
      } finally {
        if (placementReconcile.current === startupRecovery) {
          placementReconcile.current = undefined;
        }
      }
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      const startupReconcile = publishPlacementChanges(async () => {
        await rawDispatchService.reconcile("startup");
        await reconcilePublications();
      });
      placementReconcile.current = startupReconcile;
      try {
        await startupReconcile;
      } finally {
        if (placementReconcile.current === startupReconcile) {
          placementReconcile.current = undefined;
        }
      }
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      void nodeWorkspaceRetention.start();
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      params.environments.start();
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      void trackOperation(
        placementReconcile,
        publishPlacementChanges(() => sessionRetirement.reconcile()),
        "Worker placement reconcile sweep failed",
      );
      void sweepDiskSpace();
      placementReconcileInterval = setInterval(
        sweepActivePlacements,
        WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
      );
      placementReconcileInterval.unref?.();
      return sidecar;
    } catch (error) {
      try {
        await stopBeforeReady();
      } catch (cleanupError) {
        params.warn(
          `Worker placement cleanup after startup failure failed: ${formatErrorMessage(cleanupError)}`,
        );
      }
      throw error;
    }
  };
  return {
    dispatchService,
    admissionProvider,
    diskSpace,
    runnerAvailability,
    placements: params.placements,
    githubPublication,
    resolveNodeWorkspaceBinding,
    bindNodeWorkerSupervisorTransport: (transport: NodeWorkerSupervisorTransport) => {
      nodeWorkerSupervisorTransport = transport;
      nodeWorkspaceRetention.bindTransport(transport);
    },
    scheduleNodeWorkspaceRetention: (nodeId?: string) => nodeWorkspaceRetention.schedule(nodeId),
    startRuntime,
  };
}
