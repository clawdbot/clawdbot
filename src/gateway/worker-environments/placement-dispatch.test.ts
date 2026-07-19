import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
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
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerTunnelHandle } from "./tunnel.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

function createHarness(
  placementStore: PlacementStore,
  options: {
    failAt?: DispatchStage;
    destroyFails?: boolean;
    claimOnDrain?: boolean;
    reconcileFails?: boolean;
    verifyFails?: boolean;
    leaseFails?: boolean;
    localVerifyFails?: boolean;
    resumeFails?: boolean;
  } = {},
) {
  const reconciledManifestRef = MANIFEST_REF.replaceAll("b", "c");
  const log: string[] = [];
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
    acceptWorkspaceResult: (claim) => placementStore.acceptWorkspaceResult(claim),
    completeWorkspaceResultAndReleaseTurn: (claim, completionOptions) =>
      placementStore.completeWorkspaceResultAndReleaseTurn(claim, completionOptions),
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
          if (options.leaseFails) {
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
      if (options.reconcileFails) {
        throw new Error("workspace conflict");
      }
      request.journal.commit(reconciledManifestRef);
      return {
        manifestRef: reconciledManifestRef,
        changed: true,
        verifyStable: async () => {
          log.push("workspace:verify");
          if (options.verifyFails) {
            throw new Error("workspace changed after reconciliation");
          }
        },
        verifyLocalStable: async () => {
          log.push("workspace:verify-local");
          if (options.localVerifyFails) {
            throw new Error("local workspace changed after reconciliation");
          }
        },
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
  const credential: MintedWorkerCredential = {
    credential: ["worker", "credential", "fixture"].join("-"),
    deliveryId: "c".repeat(43),
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
      return credential;
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
    runReclaimBarrier: async ({ reclaim }) => await reclaim("/gateway/workspace"),
    resolveWorkspacePath: async () => {
      fail("workspace");
      return "/gateway/workspace";
    },
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

describe("worker placement dispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-dispatch-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("orders the migration barrier, provisioning, sync, attachment, and activation", async () => {
    const harness = createHarness(placementStore);

    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: MANIFEST_REF,
      remoteWorkspaceDir: "/worker/workspace",
      workerBundleHash: BUNDLE_HASH,
    });

    expect(harness.log).toEqual([
      "barrier",
      "placement:requested",
      "workspace",
      "placement:provisioning",
      "create",
      "placement:syncing",
      "tunnel:ready",
      "sync",
      "placement:starting",
      "attach",
      "tunnel:attached",
      "activation",
      "placement:active",
    ]);
  });

  it("reconciles the workspace before destroying and reclaiming an active worker", async () => {
    const harness = createHarness(placementStore);
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });

    expect(harness.log.slice(-11)).toEqual([
      "tunnel:attached",
      "workspace:quiesce",
      "workspace:reconcile",
      "workspace:verify",
      "workspace:verify-local",
      "workspace:lease",
      "workspace:verify",
      "workspace:verify-local",
      "teardown:destroy",
      "teardown:stop",
      "placement:reclaimed",
    ]);
  });

  it("recovers a completed turn's durable pending workspace result before stale-claim teardown", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "completed-turn-claim",
      runId: "completed-turn-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    await harness.service.reconcile();
    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });

    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("destroys and reclaims a pending result owned by a previous gateway instance", async () => {
    const originalHarness = createHarness(placementStore);
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "restarted-turn-claim",
      runId: "restarted-turn-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore);
    restartedHarness.markEnvironmentOwnerEpoch(2);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: restartedHarness.reconciledManifestRef,
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
    expect(restartedHarness.environments.destroy).toHaveBeenCalledOnce();
    expect(restartedHarness.log).not.toContain("workspace:resume");
  });

  it("keeps a previous-instance pending result fenced when another session is attached", async () => {
    const originalHarness = createHarness(placementStore);
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "shared-worker-claim",
      runId: "shared-worker-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(restartedStore);
    restartedHarness.markEnvironmentAttachments([REQUEST.sessionId, "session-2"]);
    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
  });

  it("recovers a draining turn result using the admitted claim generation", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "draining-result-claim",
      runId: "draining-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const draining = placementStore.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    expect(draining.generation).not.toBe(claim.placementGeneration);
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log.indexOf("workspace:resume")).toBeLessThan(
      harness.log.indexOf("teardown:destroy"),
    );
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the pending result fenced when same-instance quiescence cannot resume", async () => {
    const harness = createHarness(placementStore, { resumeFails: true });
    const active = harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "resume-failure-claim",
      runId: "resume-failure-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: { claimId: claim.claimId },
    });
    expect(placementStore.listPendingWorkspaceResults()).toHaveLength(1);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fails a pending result with diagnostics when its worker is proven lost", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "lost-result-claim",
      runId: "lost-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);
    harness.markEnvironmentDestroyed();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("lost its worker"),
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("reclaims an accepted pending result after a post-destroy gateway restart", async () => {
    const harness = createHarness(placementStore);
    const active = harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      claimId: "accepted-lost-result-claim",
      runId: "accepted-lost-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placementStore.markWorkspaceResultPending(claim);
    placementStore.updateWorkspaceBaseManifest({
      claim,
      manifestRef: harness.reconciledManifestRef,
    });
    placementStore.acceptWorkspaceResult(claim);
    placementStore.handoffWorkspaceResultRecovery(claim);
    harness.markEnvironmentDestroyed();

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("coalesces overlapping reclaim requests and accepts completed retries", async () => {
    const harness = createHarness(placementStore);
    await harness.service.dispatch(REQUEST);
    const request = {
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    };

    const [first, second] = await Promise.all([
      harness.service.reclaim(request),
      harness.service.reclaim(request),
    ]);
    const retry = await harness.service.reclaim(request);

    expect(first).toMatchObject({ state: "reclaimed" });
    expect(second).toEqual(first);
    expect(retry).toEqual(first);
    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the active worker when inbound workspace reconciliation conflicts", async () => {
    const harness = createHarness(placementStore, { reconcileFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace conflict");

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the active worker when the remote workspace changes after local acceptance", async () => {
    const harness = createHarness(placementStore, { verifyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace changed after reconciliation");

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the active worker when its quiescence lease expires", async () => {
    const harness = createHarness(placementStore, { leaseFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("workspace quiescence expired");

    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the active worker when the accepted local result changes", async () => {
    const harness = createHarness(placementStore, { localVerifyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("local workspace changed after reconciliation");

    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("workspace:resume");
  });

  it("keeps the accepted placement active when provider destruction is not proven", async () => {
    const harness = createHarness(placementStore, { destroyFails: true });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).rejects.toThrow("destroy pending");

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });
    expect(harness.log).not.toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it.each<DispatchStage>([
    "barrier",
    "workspace",
    "create",
    "tunnel:ready",
    "sync",
    "attach",
    "tunnel:attached",
    "activation",
  ])("fails closed and tears down acquired resources when %s fails", async (failAt) => {
    const harness = createHarness(placementStore, { failAt });

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(`${failAt} failed`);

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: `${failAt} failed`,
    });
    const failedAt = harness.log.indexOf("placement:failed");
    expect(failedAt).toBeGreaterThan(-1);
    const environmentAcquired = !["barrier", "workspace"].includes(failAt);
    expect(harness.log.includes("teardown:stop")).toBe(environmentAcquired);
    expect(harness.log.includes("teardown:destroy")).toBe(environmentAcquired);
    if (environmentAcquired) {
      expect(failedAt).toBeGreaterThan(harness.log.indexOf("teardown:destroy"));
    }
  });

  it("does not fail or tear down a dispatch owned by another invocation", async () => {
    placementStore.startDispatch(REQUEST);
    const harness = createHarness(placementStore);

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(
      "Cannot dispatch session session-1 from placement requested",
    );

    expect(harness.placements.current()).toMatchObject({ state: "requested" });
    expect(harness.log).not.toContain("placement:failed");
    expect(harness.log).not.toContain("teardown:destroy");
  });

  it("persists pending teardown evidence after placement is fenced", async () => {
    const harness = createHarness(placementStore, { failAt: "sync", destroyFails: true });

    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("environment destroy: destroy pending"),
    });
    expect(harness.log.filter((entry) => entry === "placement:failed")).toHaveLength(1);
  });

  it("adopts an exact active environment after restart without reprovisioning", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.log).toEqual(["environment:reconcile", "tunnel:attached", "placement:adopted"]);
    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("reclaims an active placement whose environment is already terminal after restart", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "placement:reclaimed",
    ]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("does not reclaim an active placement with an unresolved workspace journal", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    const active = placementStore.get(REQUEST.sessionId);
    expect(active?.state).toBe("active");
    if (active?.state !== "active") {
      return;
    }
    placementStore.beginWorkspaceReconciliation(
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
      },
      {
        version: 1,
        temporaryNonce: "f".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: harness.reconciledManifestRef,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "f".repeat(40),
        basePackSha256: createHash("sha256").update("").digest("hex"),
        basePack: Buffer.alloc(0),
      },
    );
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.log).toEqual(["environment:reconcile"]);
  });

  it("fails closed when an active worker turn claim cannot be proven live after restart", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Active worker turn claim cannot be proven live after gateway restart",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it("resumes a synced starting placement after restart", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "attach",
      "tunnel:attached",
      "activation",
      "placement:active",
    ]);
    expect(harness.environments.create).not.toHaveBeenCalled();
  });

  it("finishes an interrupted drain through reconciliation before failure", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedDraining(harness.attached.ownerEpoch);
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Worker dispatch interrupted in draining",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("drains, tears down, and reclaims an idle active placement with a mismatched owner", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(99);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:reclaimed",
    ]);

    const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
    await harness.service.reconcile();
    expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
  });

  it("preserves a live active turn claim during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      turnClaim: {
        claimId: "claim-1",
        runId: "run-1",
        owner: "worker",
      },
    });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fences a live turn before tearing down a mismatched runtime owner", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    placementStore.claimTurn({
      ...REQUEST,
      claimId: "claim-1",
      runId: "run-1",
      owner: {
        kind: "worker",
        environmentId: harness.attached.environmentId,
        ownerEpoch: harness.attached.ownerEpoch,
      },
    });
    harness.markEnvironmentOwnerEpoch(harness.attached.ownerEpoch + 1);
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Active worker placement does not match its environment owner",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("reclaims a terminal active environment during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "placement:reclaimed",
    ]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("limits requested runtime reconciliation to one environment", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.log).toEqual(["environment:reconcile"]);

    await harness.service.reconcileActive(harness.ready.environmentId);

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
  });

  it("does not retry unrelated failed teardown during requested reconciliation", async () => {
    const harness = createHarness(placementStore, { failAt: "sync", destroyFails: true });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    harness.log.length = 0;
    vi.mocked(harness.environments.destroy).mockClear();

    await harness.service.reconcileActive("worker-other");

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("fences a turn admitted immediately before runtime drain", async () => {
    const harness = createHarness(placementStore, { claimOnDrain: true });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentDestroyed();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Active worker disappeared during an admitted turn",
    });
    expect(harness.log).toEqual([
      "environment:reconcile",
      "placement:draining",
      "placement:reconciling",
      "teardown:stop",
      "teardown:destroy",
      "placement:failed",
    ]);
  });

  it("leaves in-flight dispatch preparation untouched during runtime reconciliation", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.log.length = 0;

    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({ state: "starting" });
    expect(harness.log).toEqual(["environment:reconcile"]);
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
