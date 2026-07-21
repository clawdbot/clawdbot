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
import type { WorkerTunnelHandle } from "./tunnel.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

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
    localVerifyFails?: boolean;
    resumeFails?: boolean;
    workspacePath?: string;
    priorWorkspaceResultConflict?: { paths: string[]; stagedResultRef: string };
    reconcileConflictPaths?: string[];
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
      throw new Error(`${stage} failed`);
    }
  };
  const placements: WorkerDispatchPlacementStore = {
    get: (sessionId) => placementStore.get(sessionId),
    loadWorkspaceReconciliation: (owner) => placementStore.loadWorkspaceReconciliation(owner),
    beginWorkspaceReconciliation: (owner, journal) =>
      placementStore.beginWorkspaceReconciliation(owner, journal),
    abortWorkspaceReconciliation: (owner) => placementStore.abortWorkspaceReconciliation(owner),
    listWorkspaceReconciliationOwners: () => placementStore.listWorkspaceReconciliationOwners(),
    listPendingWorkspaceResults: () => placementStore.listPendingWorkspaceResults(),
    workspaceResultInstanceId: () => placementStore.workspaceResultInstanceId(),
    recordStagedWorkspaceResult: (claim, ref) =>
      placementStore.recordStagedWorkspaceResult(claim, ref),
    recordWorkspaceResultConflict: (claim, conflict) =>
      placementStore.recordWorkspaceResultConflict(claim, conflict),
    claimTurn: (params) => placementStore.claimTurn(params),
    claimReclaimWorkspaceResult: (params) => placementStore.claimReclaimWorkspaceResult(params),
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
    createDispatchEnvironmentFixtures();
  let currentEnvironment: ReturnType<WorkerDispatchEnvironmentService["get"]> = ready;
  const tunnelHandle = (ownerEpoch: number): WorkerTunnelHandle => ({
    environmentId: ready.environmentId,
    ownerEpoch,
    remoteSocketPath: "/worker/gateway.sock",
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
    reconcileWorkspace: vi.fn(async (request) => {
      log.push("workspace:reconcile");
      if (options.reconcileFails || remainingReconcileFailures > 0) {
        remainingReconcileFailures -= 1;
        throw new Error("workspace conflict");
      }
      if (options.reconcileCommitsManifest !== false) {
        request.journal.commit(reconciledManifestRef);
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
  const environments: WorkerDispatchEnvironmentService = {
    create: vi.fn(async () => {
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
      fail(ownerEpoch === 1 ? "tunnel:ready" : "tunnel:attached");
      return tunnelHandle(ownerEpoch);
    }),
    stopTunnel: vi.fn(async () => {
      log.push("teardown:stop");
    }),
    destroy: vi.fn(async () => {
      log.push("teardown:destroy");
      if (options.destroyFails) {
        throw new Error("destroy pending");
      }
      const destroyed = destroyedEnvironment((currentEnvironment?.ownerEpoch ?? 1) + 1);
      currentEnvironment = destroyed;
      return destroyed;
    }),
    reconcileOnce: vi.fn(async () => {
      log.push("environment:reconcile");
    }),
  };
  const service = createWorkerPlacementDispatchService({
    placements,
    environments,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => {
      log.push("barrier");
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
      seedActive: (ownerEpoch: number) =>
        seedActivePlacement(placementStore, { environmentId, ownerEpoch }),
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
    markEnvironmentOwnerEpoch: (ownerEpoch: number) => {
      currentEnvironment = { ...attached, ownerEpoch };
    },
    markEnvironmentAttachments: (attachedSessionIds: string[]) => {
      currentEnvironment = { ...attached, attachedSessionIds };
    },
    service,
    ready,
    attached,
  };
}
