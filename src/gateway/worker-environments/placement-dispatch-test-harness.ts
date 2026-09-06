import { vi } from "vitest";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
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
  seedProvisioningPlacement,
  seedStartingPlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import { completeReclaimedWorkspaceTeardown } from "./placement-teardown.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerWorkspaceReconcileRequest,
} from "./tunnel-contract.js";
import type { WorkerTunnelHandle } from "./tunnel.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceRecoveryFailureReport,
  type WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";
import {
  createWorkerWorkspaceOperationCoordinator,
  type WorkerWorkspaceOperationCoordinator,
} from "./workspace-operation-coordinator.js";

export function createHarness(
  placementStore: PlacementStore,
  options: {
    environmentService?: WorkerEnvironmentService;
    runReclaimPreparation?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["runReclaimPreparation"];
    runReclaimBarrier?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["runReclaimBarrier"];
    runFailedReclaimBarrier?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["runFailedReclaimBarrier"];
    prepareGatewayMove?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["prepareGatewayMove"];
    failAt?: DispatchStage;
    destroyFails?: boolean;
    destroyFailureCount?: number;
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
    localVerifyFails?: boolean;
    resumeFails?: boolean;
    workspacePath?: string;
    priorWorkspaceResultConflict?: { paths: string[]; stagedResultRef: string };
    priorWorkspaceResultConflictLookup?: WorkspaceResultConflictLookup;
    reconcileConflictPaths?: string[];
    workspaceOperations?: WorkerWorkspaceOperationCoordinator;
    destroyFailureState?: "draining" | "destroying";
    terminalizeReclaimOnTunnelDrop?: boolean;
    terminalizedReclaimError?: Error;
    environmentGeneration?: number;
    failMoveAfterBegin?: boolean;
    runMoveBarrier?: Parameters<typeof createWorkerPlacementDispatchService>[0]["runMoveBarrier"];
    recoveryBarrierError?: Error;
    isShuttingDown?: () => boolean;
    prepareAcceptedWorkspacePublication?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["prepareAcceptedWorkspacePublication"];
    publishAcceptedWorkspace?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["publishAcceptedWorkspace"];
    beforeMoveBegin?: (abandoned: { runId: string } | undefined) => Promise<void>;
    afterMoveBegin?: () => void;
    afterDestroy?: () => Promise<void> | void;
    afterReconcile?: () => Promise<void> | void;
    afterStopTunnel?: () => Promise<void> | void;
    deviceRunnerAvailable?: boolean;
    isCurrentNodePlacement?: Parameters<
      typeof createWorkerPlacementDispatchService
    >[0]["isCurrentNodePlacement"];
  } = {},
) {
  const reconciledManifestRef = MANIFEST_REF.replaceAll("b", "c");
  let remainingDestroyFailures = options.destroyFailureCount ?? 0;
  let remainingReconcileFailures = options.reconcileFailureCount ?? 0;
  let remainingLeaseFailures = options.leaseFailureCount ?? 0;
  let verifyCalls = 0;
  const log: string[] = [];
  const reportWorkspaceResultConflict = vi.fn(async () => {});
  const reportWorkspaceResultRecoveryFailure = vi.fn(
    async (_recovery: WorkerWorkspaceRecoveryFailureReport) => {},
  );
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
    getWorkspaceReconciliationPlacement: (owner) =>
      placementStore.getWorkspaceReconciliationPlacement(owner),
    listWorkspaceReconciliationOwners: () => placementStore.listWorkspaceReconciliationOwners(),
    listPendingWorkspaceResults: () => placementStore.listPendingWorkspaceResults(),
    workspaceResultInstanceId: () => placementStore.workspaceResultInstanceId(),
    validateWorkspaceResultClaim: (claim) => placementStore.validateWorkspaceResultClaim(claim),
    recordStagedWorkspaceResult: (claim, ref, repositoryWorkspaceId) =>
      placementStore.recordStagedWorkspaceResult(claim, ref, repositoryWorkspaceId),
    recordWorkspaceResultConflict: (claim, conflict) =>
      placementStore.recordWorkspaceResultConflict(claim, conflict),
    claimTurn: (params) => placementStore.claimTurn(params),
    claimReclaimWorkspaceResult: (params) => placementStore.claimReclaimWorkspaceResult(params),
    closeWorkerTurnToolState: (claim) => placementStore.closeWorkerTurnToolState(claim),
    beginPlacementMove: (params) => {
      const begun = placementStore.beginPlacementMove(params);
      if (!begun.joined) {
        log.push("placement:draining");
      }
      return begun;
    },
    cancelPlacementMove: (params) => placementStore.cancelPlacementMove(params),
    completePlacementMoveSourceToLocal: (params) => {
      log.push("placement:local");
      return placementStore.completePlacementMoveSourceToLocal(params);
    },
    completeAbandonedPlacementMoveSourceToLocal: (params) => {
      log.push("placement:local");
      return placementStore.completeAbandonedPlacementMoveSourceToLocal(params);
    },
    completePlacementMoveToWorker: (params) => placementStore.completePlacementMoveToWorker(params),
    getPlacementMove: (sessionId) => placementStore.getPlacementMove(sessionId),
    listPlacementMoves: () => placementStore.listPlacementMoves(),
    recordPlacementMoveError: (params) => placementStore.recordPlacementMoveError(params),
    markWorkspaceResultPending: (claim) => placementStore.markWorkspaceResultPending(claim),
    acceptWorkspaceResult: (claim) => placementStore.acceptWorkspaceResult(claim),
    handoffWorkspaceResultRecovery: (claim) => placementStore.handoffWorkspaceResultRecovery(claim),
    cancelWorkspaceResultAndReleaseTurn: (claim) =>
      placementStore.cancelWorkspaceResultAndReleaseTurn(claim),
    completeWorkspaceResultAndReleaseTurn: (claim) =>
      placementStore.completeWorkspaceResultAndReleaseTurn(claim),
    failWorkspaceResultAndReleaseTurn: (pending, error) => {
      const current = placementStore.get(pending.sessionId);
      if (current?.state === "active") {
        log.push("placement:draining");
      }
      log.push("placement:reconciling", "placement:failed");
      return placementStore.failWorkspaceResultAndReleaseTurn(pending, error);
    },
    abandonWorkspaceResult: (pending) => placementStore.abandonWorkspaceResult(pending),
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
    startWorkspaceResultDrain: (claim) => {
      log.push("placement:draining");
      return placementStore.startWorkspaceResultDrain(claim);
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
    measureLaunchTurn: vi.fn(),
    launchTurn: vi.fn(),
    quiesceWorkspace: vi.fn(async () => {
      log.push("workspace:quiesce");
      return {
        assertActive: vi.fn(async () => {
          log.push("workspace:lease");
          if (options.leaseFails || remainingLeaseFailures > 0) {
            remainingLeaseFailures -= 1;
            throw new Error("workspace quiescence expired");
          }
        }),
        resume: vi.fn(async () => {
          log.push("workspace:resume");
          if (options.resumeFails) {
            throw new Error("workspace resume failed");
          }
        }),
      };
    }),
    reconcileWorkspace: vi.fn(async (request: WorkerWorkspaceReconcileRequest) => {
      if (request.source.kind !== "local") {
        throw new Error("Local dispatch fixture received a repository workspace");
      }
      const { journal, stagedResult } = request.source;
      log.push("workspace:reconcile");
      if (options.reconcileFails || remainingReconcileFailures > 0) {
        remainingReconcileFailures -= 1;
        throw new Error("workspace conflict");
      }
      if (options.reconcileCommitsManifest !== false) {
        journal.commit(reconciledManifestRef);
      }
      if (options.terminalizeReclaimOnTunnelDrop) {
        const owned = placementStore.get(REQUEST.sessionId);
        const persistedClaim = owned?.turnClaim;
        if (owned?.state !== "draining" || persistedClaim?.owner !== "worker") {
          throw new Error("tunnel-drop fixture lost its draining worker claim");
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
        completeReclaimedWorkspaceTeardown({
          placements: placementStore,
          turnClaim: claim,
          environmentId: owned.environmentId,
          ownerEpoch: owned.activeOwnerEpoch,
        });
        throw options.terminalizedReclaimError ?? new WorkerTunnelOwnerDisconnectedError();
      }
      if (options.reconcileConflictPaths?.length && stagedResult) {
        stagedResult.record(stagedResult.ref);
      }
      await options.afterReconcile?.();
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
                journal.commit(reconciledManifestRef);
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
  const environments: WorkerDispatchEnvironmentService &
    Pick<WorkerEnvironmentService, "recordError" | "requestDestroy"> = {
    recordError: vi.fn((record) => record),
    supportsProviderExecutionMode: vi.fn(() => true),
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
      await options.afterStopTunnel?.();
    }),
    destroy: vi.fn(async () => {
      log.push("teardown:destroy");
      if (options.destroyFails || remainingDestroyFailures > 0) {
        if (remainingDestroyFailures > 0) {
          remainingDestroyFailures -= 1;
        }
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
      await options.afterDestroy?.();
      return destroyed;
    }),
    requestDestroy: (requestedEnvironmentId) => environments.destroy(requestedEnvironmentId),
    reconcileOnce: vi.fn(async () => {
      log.push("environment:reconcile");
    }),
    reconcileEnvironment: vi.fn(async () => {
      log.push("environment:reconcile");
    }),
  };
  if (options.environmentService) {
    Object.assign(environments, options.environmentService);
  }
  const service = createWorkerPlacementDispatchService({
    placements,
    environments,
    isShuttingDown: options.isShuttingDown,
    prepareGatewayMove: options.prepareGatewayMove,
    runReclaimPreparation:
      options.runReclaimPreparation ?? (async ({ run, authorize }) => await run(authorize)),
    runnerAvailability: createWorkerPlacementRunnerAvailabilityReader({
      environments,
      hasCurrentDeviceRunner: () => options.deviceRunnerAvailable === true,
    }),
    workspaceOperations: options.workspaceOperations ?? createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ authorize, startDispatch }) => {
      log.push("barrier");
      if (options.failAt === "preflight") {
        fail("preflight");
      }
      authorize?.();
      const placement = startDispatch();
      if (options.failAt === "barrier") {
        throw new Error("barrier failed");
      }
      return placement;
    },
    runRecoveryBarrier: async ({ run }) => {
      log.push("recovery-barrier");
      if (options.recoveryBarrierError) {
        throw options.recoveryBarrierError;
      }
      await run({ kind: "local", path: options.workspacePath ?? "/gateway/workspace" });
    },
    runActivationBarrier: async ({ authorize, activate }) => {
      authorize?.();
      fail("activation");
      return activate();
    },
    runMoveBarrier:
      options.runMoveBarrier ??
      (async ({ authorize, begin }) => {
        authorize?.();
        const begun = await begin(async (runId) => {
          if (options.beforeMoveBegin) {
            await options.beforeMoveBegin({ runId });
            authorize?.();
          }
        });
        options.afterMoveBegin?.();
        if (options.failMoveAfterBegin) {
          throw new Error("move barrier interrupted");
        }
        return begun;
      }),
    resolveMoveDestination: async (_identity, target) =>
      target.kind === "gateway"
        ? undefined
        : {
            profileId: target.kind === "profile" ? target.profileId : `device:${target.deviceId}`,
            executionMode: REQUEST.executionMode,
            ...(target.kind === "device"
              ? {
                  deviceId: target.deviceId,
                  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
                }
              : {}),
          },
    resolveDevicePlacementRequirement: async ({ executionMode }) =>
      executionMode === "remote-exec"
        ? {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          }
        : { requiredNodeCommands: [], consumesWorkerSlot: true },
    isCurrentNodePlacement: options.isCurrentNodePlacement ?? (() => true),
    runReclaimBarrier:
      options.runReclaimBarrier ??
      (async ({ sessionId, sessionKey, authorize, beforeDrain, begin, reclaim }) =>
        await runExclusiveSessionLifecycleMutation({
          scope: options.workspacePath ?? "/gateway/workspace",
          identities: [sessionId, sessionKey],
          run: async () => {
            authorize?.();
            beforeDrain?.();
            const placement = begin();
            return placement.state === "reclaimed"
              ? placement
              : await reclaim(
                  { kind: "local", path: options.workspacePath ?? "/gateway/workspace" },
                  placement,
                  authorize,
                );
          },
        })),
    runFailedReclaimBarrier:
      options.runFailedReclaimBarrier ??
      (async ({ sessionId, sessionKey, authorize, reclaim }) =>
        await runExclusiveSessionLifecycleMutation({
          scope: options.workspacePath ?? "/gateway/workspace",
          identities: [sessionId, sessionKey],
          run: async () => {
            authorize?.();
            return await reclaim(authorize);
          },
        })),
    resolveWorkspace: async () => {
      fail("workspace");
      return { kind: "local", path: options.workspacePath ?? "/gateway/workspace" };
    },
    reportWorkspaceResultConflict,
    reportWorkspaceResultRecoveryFailure,
    resolveWorkspaceResultConflict: vi.fn(async (): Promise<WorkspaceResultConflictLookup> => {
      const conflict = options.priorWorkspaceResultConflict;
      return (
        options.priorWorkspaceResultConflictLookup ??
        (conflict
          ? {
              kind: "conflict",
              conflict: projectWorkspaceResultConflict(conflict.paths, conflict.stagedResultRef),
            }
          : { kind: "absent" })
      );
    }),
    ...(options.prepareAcceptedWorkspacePublication
      ? { prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication }
      : {}),
    ...(options.publishAcceptedWorkspace
      ? { publishAcceptedWorkspace: options.publishAcceptedWorkspace }
      : {}),
  });
  return {
    log,
    reconciledManifestRef,
    placements: {
      current: () => placementStore.get(REQUEST.sessionId),
      seedProvisioning: (executionMode?: "worker-turn" | "remote-exec") =>
        seedProvisioningPlacement(placementStore, environmentId, executionMode),
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
    reportWorkspaceResultRecoveryFailure,
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
    markEnvironmentNodeDeviceId: (nodeDeviceId: string) => {
      currentEnvironment = { ...attached, providerId: "device", nodeDeviceId, sshEndpoint: null };
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

export const createRecoveryService = (
  placements: PlacementStore,
  environments: WorkerEnvironmentService,
  isShuttingDown: () => boolean = () => false,
) =>
  createWorkerPlacementDispatchService({
    placements,
    environments,
    isShuttingDown,
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: "/gateway/workspace" }),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: "/gateway/workspace" }, begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    resolveWorkspace: async () => ({ kind: "local", path: "/gateway/workspace" }),
    reportWorkspaceResultConflict: async () => {},
    resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
  });
