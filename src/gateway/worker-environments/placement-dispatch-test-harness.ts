import { vi } from "vitest";
import type { MintedWorkerCredential } from "./credential.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  BUNDLE_HASH,
  createDispatchEnvironmentFixtures,
  type DispatchStage,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
  seedActivePlacement,
  seedStartingPlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import type { WorkerTunnelHandle } from "./tunnel.js";
import {
  createWorkerWorkspaceOperationCoordinator,
  type WorkerWorkspaceOperationCoordinator,
} from "./workspace-operation-coordinator.js";

export function createHarness(
  placementStore: PlacementStore,
  options: {
    failAt?: DispatchStage;
    destroyFails?: boolean;
    claimOnDrain?: boolean;
    reconcileFails?: boolean;
    reconcileFailureCount?: number;
    reconcileChanged?: boolean;
    reconcileCommitsManifest?: boolean;
    reconcileCommitsManifestOnApply?: boolean;
    verifyFails?: boolean;
    verifyFailureCall?: number;
    leaseFails?: boolean;
    leaseFailureCount?: number;
    leaseError?: Error;
    leaseBarrier?: Promise<void>;
    localVerifyFails?: boolean;
    resumeFails?: boolean;
    resumeError?: Error;
    workspacePath?: string;
    priorWorkspaceResultConflict?: { paths: string[]; stagedResultRef: string };
    reconcileConflictPaths?: string[];
    workspaceOperations?: WorkerWorkspaceOperationCoordinator;
    destroyFailureState?: "draining" | "destroying";
    terminalizeReclaimOnTunnelDrop?: boolean;
    terminalizedReclaimError?: Error;
    environmentGeneration?: number;
    hostIsolationFresh?: boolean;
  } = {},
) {
  const reconciledManifestRef = MANIFEST_REF.replaceAll("b", "c");
  let remainingReconcileFailures = options.reconcileFailureCount ?? 0;
  let remainingLeaseFailures = options.leaseFailureCount ?? 0;
  let verifyCalls = 0;
  const log: string[] = [];
  const reportWorkspaceResultConflict = vi.fn(async () => {});
  const fail = (stage: DispatchStage) => {
    log.push(stage);
    if (options.failAt === stage) {
      const error = new Error(`${stage} failed`);
      if (stage === "preflight") {
        Object.assign(error, { code: "invalid_state" });
      }
      throw error;
    }
  };
  const placements: WorkerDispatchPlacementStore = {
    get: (sessionId) => placementStore.get(sessionId),
    loadWorkspaceReconciliation: (owner, loadOptions) =>
      placementStore.loadWorkspaceReconciliation(owner, loadOptions),
    beginWorkspaceReconciliation: (owner, journal) =>
      placementStore.beginWorkspaceReconciliation(owner, journal),
    abortWorkspaceReconciliation: (owner, abortOptions) =>
      placementStore.abortWorkspaceReconciliation(owner, abortOptions),
    isWorkspaceReconciliationRetainedForForcedAbandonment: (owner) =>
      placementStore.isWorkspaceReconciliationRetainedForForcedAbandonment(owner),
    retainWorkspaceReconciliationForForcedAbandonment: (owner) =>
      placementStore.retainWorkspaceReconciliationForForcedAbandonment(owner),
    listWorkspaceReconciliationOwners: () => placementStore.listWorkspaceReconciliationOwners(),
    listEnvironmentTeardownFences: (environmentId) =>
      placementStore.listEnvironmentTeardownFences(environmentId),
    canDestroyAcceptedWorkspaceResult: (claim) =>
      placementStore.canDestroyAcceptedWorkspaceResult(claim),
    canDestroyForceAbandonedEnvironment: (environmentId) =>
      placementStore.canDestroyForceAbandonedEnvironment(environmentId),
    listPendingWorkspaceResults: () => placementStore.listPendingWorkspaceResults(),
    workspaceResultInstanceId: () => placementStore.workspaceResultInstanceId(),
    validateWorkspaceResultClaim: (claim) => placementStore.validateWorkspaceResultClaim(claim),
    recordStagedWorkspaceResult: (claim, ref) =>
      placementStore.recordStagedWorkspaceResult(claim, ref),
    recordWorkspaceResultConflict: (claim, conflict) =>
      placementStore.recordWorkspaceResultConflict(claim, conflict),
    claimTurn: (params) => placementStore.claimTurn(params),
    claimReclaimWorkspaceResult: (params) => placementStore.claimReclaimWorkspaceResult(params),
    closeWorkerTurnToolState: (claim) => placementStore.closeWorkerTurnToolState(claim),
    markWorkspaceResultPending: (claim) => placementStore.markWorkspaceResultPending(claim),
    acceptWorkspaceResult: (claim) => placementStore.acceptWorkspaceResult(claim),
    cancelWorkspaceResultAndReleaseTurn: (claim) =>
      placementStore.cancelWorkspaceResultAndReleaseTurn(claim),
    completeWorkspaceResultAndReleaseTurn: (claim, completionOptions) => {
      const completed = placementStore.completeWorkspaceResultAndReleaseTurn(
        claim,
        completionOptions,
      );
      if (completionOptions?.reclaim) {
        log.push("placement:reclaimed");
      }
      return completed;
    },
    failWorkspaceResultAndReleaseTurn: (pending, error) => {
      const current = placementStore.get(pending.sessionId);
      if (current?.state === "active") {
        log.push("placement:draining");
      }
      log.push("placement:reconciling", "placement:failed");
      return placementStore.failWorkspaceResultAndReleaseTurn(pending, error);
    },
    abandonWorkspaceResult: (pending) => placementStore.abandonWorkspaceResult(pending),
    forceAbandonPendingWorkspaceResult: (params) =>
      placementStore.forceAbandonPendingWorkspaceResult(params),
    forceAbandonWorkerTurn: (params) => placementStore.forceAbandonWorkerTurn(params),
    releaseTurn: (claim) => placementStore.releaseTurn(claim),
    updateWorkspaceBaseManifest: (params) => placementStore.updateWorkspaceBaseManifest(params),
    acceptIdleWorkspaceReconciliation: (params) =>
      placementStore.acceptIdleWorkspaceReconciliation(params),
    startDispatch: (params) => {
      log.push("placement:requested");
      return placementStore.startDispatch(params);
    },
    transition: (params) => {
      log.push(`placement:${params.to}`);
      return placementStore.transition(params);
    },
    fail: (params) => {
      log.push("placement:failed");
      return placementStore.fail(params);
    },
    failPendingWorkspaceResult: (params) => {
      log.push("placement:failed");
      return placementStore.failPendingWorkspaceResult(params);
    },
    finishReclaim: (params) => {
      log.push("placement:reclaimed");
      if (options.claimOnDrain && !placementStore.get(params.sessionId)?.turnClaim) {
        placementStore.claimTurn({
          sessionId: params.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          claimId: "claim-on-drain",
          runId: "run-on-drain",
          owner: {
            kind: "worker",
            environmentId: params.environmentId,
            ownerEpoch: params.ownerEpoch,
          },
        });
      }
      return placementStore.finishReclaim(params);
    },
    list: () => placementStore.list(),
    listForReconcile: () => placementStore.listForReconcile(),
    startDrain: (params) => {
      log.push("placement:draining");
      if (options.claimOnDrain && !placementStore.get(params.sessionId)?.turnClaim) {
        placementStore.claimTurn({
          sessionId: params.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          claimId: "claim-on-drain",
          runId: "run-on-drain",
          owner: {
            kind: "worker",
            environmentId: params.environmentId,
            ownerEpoch: params.ownerEpoch,
          },
        });
      }
      return placementStore.startDrain(params);
    },
    startReconcile: (params) => {
      log.push("placement:reconciling");
      return placementStore.startReconcile(params);
    },
    adoptActive: (params) => {
      log.push("placement:adopted");
      return placementStore.adoptActive(params);
    },
  };
  const { attached, destroyedEnvironment, environmentId, ready } =
    createDispatchEnvironmentFixtures(options.environmentGeneration);
  let currentEnvironment: ReturnType<WorkerDispatchEnvironmentService["get"]> = ready;
  const tunnelHandle = (ownerEpoch: number): WorkerTunnelHandle => ({
    environmentId: ready.environmentId,
    ownerEpoch,
    launchTurn: vi.fn(),
    quiesceWorkspace: vi.fn(async () => {
      log.push("workspace:quiesce");
      return {
        assertActive: vi.fn(async () => {
          log.push("workspace:lease");
          await options.leaseBarrier;
          if (options.leaseError) {
            throw options.leaseError;
          }
          if (options.leaseFails || remainingLeaseFailures > 0) {
            remainingLeaseFailures -= 1;
            throw new Error("workspace quiescence expired");
          }
        }),
        resume: vi.fn(async () => {
          log.push("workspace:resume");
          if (options.resumeError) {
            throw options.resumeError;
          }
          if (options.resumeFails) {
            throw new Error("workspace resume failed");
          }
        }),
      };
    }),
    reconcileWorkspace: vi.fn(async (request) => {
      log.push("workspace:reconcile");
      if (options.reconcileFails || remainingReconcileFailures > 0) {
        remainingReconcileFailures -= 1;
        throw new Error("workspace conflict");
      }
      if (options.reconcileCommitsManifest !== false) {
        request.journal.commit(reconciledManifestRef);
      }
      if (options.terminalizeReclaimOnTunnelDrop) {
        const owned = placementStore.get(REQUEST.sessionId);
        const persistedClaim = owned?.turnClaim;
        if (owned?.state !== "active" || persistedClaim?.owner !== "worker") {
          throw new Error("tunnel-drop fixture lost its active worker claim");
        }
        const claim = {
          sessionId: owned.sessionId,
          claimId: persistedClaim.claimId,
          runId: persistedClaim.runId,
          placementGeneration: persistedClaim.generation,
          owner: {
            kind: "worker" as const,
            environmentId: owned.environmentId,
            ownerEpoch: persistedClaim.ownerEpoch,
          },
        };
        placementStore.acceptWorkspaceResult(claim);
        currentEnvironment = destroyedEnvironment(currentEnvironment?.ownerEpoch ?? 1);
        log.push("teardown:destroy");
        placementStore.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true });
        throw options.terminalizedReclaimError ?? new WorkerTunnelOwnerDisconnectedError();
      }
      if (options.reconcileConflictPaths?.length && request.stagedResult) {
        request.stagedResult.record(request.stagedResult.ref);
      }
      return {
        manifestRef: reconciledManifestRef,
        changed: options.reconcileChanged ?? true,
        verifyStable: async () => {
          log.push("workspace:verify");
          verifyCalls += 1;
          if (options.verifyFails || verifyCalls === options.verifyFailureCall) {
            throw new Error("workspace changed after reconciliation");
          }
        },
        verifyLocalStable: async () => {
          log.push("workspace:verify-local");
          if (options.localVerifyFails) {
            throw new Error("local workspace changed after reconciliation");
          }
        },
        getAppliedWorkspaceResult: options.reconcileConflictPaths?.length
          ? () => ({
              manifestRef: reconciledManifestRef,
              manifest: { version: 1 as const, baseCommit: null, entries: [] },
              conflictPaths: options.reconcileConflictPaths!,
              verifyLocalStable: async () => {},
            })
          : undefined,
        ...(options.reconcileCommitsManifestOnApply
          ? {
              applyPreparedStagedResult: async () => {
                log.push("workspace:apply-prepared");
                request.journal.commit(reconciledManifestRef);
              },
              publishStagedResult: async () => {},
            }
          : {}),
      };
    }),
    runWorkspaceCommand: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    })),
    syncWorkspace: vi.fn(async () => {
      fail("sync");
      return {
        mode: "git" as const,
        remoteWorkspaceDir: "/worker/workspace",
        manifestRef: MANIFEST_REF,
      };
    }),
    stop: vi.fn(async () => {}),
  });
  const minted: MintedWorkerCredential = {
    credential: "fixture-credential",
    deliveryId: "fixture-delivery-id",
    environmentId: ready.environmentId,
    bundleHash: BUNDLE_HASH,
    sessionId: REQUEST.sessionId,
    rpcSetVersion: 1,
    ownerEpoch: 2,
    expiresAtMs: 10_000,
  };
  const destroy = vi.fn(async (_environmentId: string) => {
    log.push("teardown:destroy");
    if (options.destroyFails) {
      if (options.destroyFailureState) {
        currentEnvironment = {
          ...attached,
          state: options.destroyFailureState,
          tunnelStatus: "stopped",
        };
      }
      throw new Error("destroy pending");
    }
    const destroyed = destroyedEnvironment((currentEnvironment?.ownerEpoch ?? 1) + 1);
    currentEnvironment = destroyed;
    return destroyed;
  });
  const environments: WorkerDispatchEnvironmentService = {
    create: vi.fn(async () => {
      fail("create");
      return currentEnvironment ?? ready;
    }),
    createFromProfileSnapshot: vi.fn(async () => {
      fail("create");
      return ready;
    }),
    get: vi.fn(() => currentEnvironment),
    attachSession: vi.fn(async () => {
      fail("attach");
      currentEnvironment = attached;
      return minted;
    }),
    startTunnel: vi.fn(async ({ ownerEpoch }) => {
      fail("tunnel:attached");
      if (ownerEpoch !== currentEnvironment?.ownerEpoch) {
        throw new Error("tunnel fixture received a stale owner epoch");
      }
      return tunnelHandle(ownerEpoch);
    }),
    stopTunnel: vi.fn(async () => {
      log.push("teardown:stop");
    }),
    destroy,
    destroyOwned: vi.fn(async (ownedEnvironmentId, authorizeTeardown) => {
      if (!authorizeTeardown()) {
        throw new Error("owned teardown authorization changed");
      }
      return await destroy(ownedEnvironmentId);
    }),
    reconcileOnce: vi.fn(async () => {
      log.push("environment:reconcile");
      return currentEnvironment
        ? [
            {
              environmentId: currentEnvironment.environmentId,
              hostIsolation: options.hostIsolationFresh === false ? "unavailable" : "fresh",
            } as const,
          ]
        : [];
    }),
  };
  const service = createWorkerPlacementDispatchService({
    placements,
    environments,
    workspaceOperations: options.workspaceOperations ?? createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => {
      log.push("barrier");
      if (options.failAt === "preflight") {
        fail("preflight");
      }
      const placement = startDispatch();
      if (options.failAt === "barrier") {
        throw new Error("barrier failed");
      }
      return placement;
    },
    runActivationBarrier: async ({ activate }) => {
      fail("activation");
      return activate();
    },
    runReclaimBarrier: async ({ reclaim }) =>
      await reclaim(options.workspacePath ?? "/gateway/workspace"),
    resolveWorkspacePath: async () => {
      fail("workspace");
      return options.workspacePath ?? "/gateway/workspace";
    },
    reportWorkspaceResultConflict,
    resolveWorkspaceResultConflict: vi.fn(async () => options.priorWorkspaceResultConflict),
  });
  return {
    log,
    reconciledManifestRef,
    placements: {
      current: () => placementStore.get(REQUEST.sessionId),
      seedStarting: () => seedStartingPlacement(placementStore, environmentId),
      seedActive: (ownerEpoch: number, executionMode?: "worker-turn" | "remote-exec") =>
        seedActivePlacement(placementStore, { environmentId, ownerEpoch, executionMode }),
      seedDraining: (ownerEpoch: number) => {
        const active = seedActivePlacement(placementStore, { environmentId, ownerEpoch });
        if (active.state !== "active") {
          throw new Error("active placement fixture was not active");
        }
        return placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      },
    },
    environments,
    reportWorkspaceResultConflict,
    markEnvironmentDestroyed: () => {
      currentEnvironment = destroyedEnvironment((currentEnvironment?.ownerEpoch ?? 1) + 1);
    },
    markEnvironmentFailed: () => {
      currentEnvironment = {
        ...destroyedEnvironment(currentEnvironment?.ownerEpoch ?? 1),
        state: "failed",
        leaseId: null,
        sshEndpoint: null,
        sharedHost: null,
        lastError: "Worker environment disappeared before teardown was requested",
        error: "Worker environment disappeared before teardown was requested",
      };
    },
    markEnvironmentOwnerEpoch: (ownerEpoch: number) => {
      currentEnvironment = { ...attached, ownerEpoch };
    },
    markEnvironmentProviderId: (providerId: string) => {
      currentEnvironment = { ...attached, providerId };
    },
    markEnvironmentAttachments: (attachedSessionIds: string[]) => {
      currentEnvironment = { ...attached, attachedSessionIds };
    },
    markEnvironmentProtocolFeatures: (protocolFeatures: string[]) => {
      if (!currentEnvironment?.bootstrapReceipt) {
        throw new Error("worker environment fixture has no bootstrap receipt");
      }
      currentEnvironment = {
        ...currentEnvironment,
        bootstrapReceipt: { ...currentEnvironment.bootstrapReceipt, protocolFeatures },
      };
    },
    service,
    ready,
    attached,
  };
}
