import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
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
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "./placement-store.js";
import { workerEnvironmentIdForIdempotencyKey } from "./service.js";
import type { WorkerTunnelHandle } from "./tunnel.js";

type WorkerDispatchRequest = Parameters<
  ReturnType<typeof createWorkerPlacementDispatchService>["dispatch"]
>[0];

const BUNDLE_HASH = "a".repeat(64);
const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const REQUEST: WorkerDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "development",
};

type PlacementStore = ReturnType<typeof createWorkerSessionPlacementStore>;
type DispatchEnvironmentRecord = Awaited<ReturnType<WorkerDispatchEnvironmentService["create"]>>;
type DispatchStage =
  | "barrier"
  | "workspace"
  | "create"
  | "tunnel:ready"
  | "sync"
  | "attach"
  | "tunnel:attached"
  | "activation";

function seedStartingPlacement(
  store: PlacementStore,
  environmentId: string,
): WorkerSessionPlacementRecord {
  let current = store.startDispatch(REQUEST);
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: current.generation,
    patch: { environmentId },
  });
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: current.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  current = store.transition({
    sessionId: REQUEST.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: current.generation,
    patch: {
      workspaceBaseManifestRef: MANIFEST_REF,
      remoteWorkspaceDir: "/worker/workspace",
    },
  });
  return current;
}

function seedActivePlacement(
  store: PlacementStore,
  params: { environmentId: string; ownerEpoch: number },
): WorkerSessionPlacementRecord {
  const current = seedStartingPlacement(store, params.environmentId);
  return store.transition({
    sessionId: REQUEST.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: current.generation,
    patch: { activeOwnerEpoch: params.ownerEpoch },
  });
}

function createHarness(
  placementStore: PlacementStore,
  options: { failAt?: DispatchStage; destroyFails?: boolean; claimOnDrain?: boolean } = {},
) {
  const log: string[] = [];
  const fail = (stage: DispatchStage) => {
    log.push(stage);
    if (options.failAt === stage) {
      throw new Error(`${stage} failed`);
    }
  };
  const placements: WorkerDispatchPlacementStore = {
    get: (sessionId) => placementStore.get(sessionId),
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
    listForReconcile: () => placementStore.listForReconcile(),
    startDrain: (params) => {
      log.push("placement:draining");
      if (options.claimOnDrain) {
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
  const environmentId = workerEnvironmentIdForIdempotencyKey(
    `session-dispatch:${REQUEST.sessionId}:1`,
  );
  const profileSnapshot: WorkerProfile = {
    settings: { region: "test" },
  };
  const bootstrapReceipt: WorkerAdmissionHandshake = {
    bundleHash: BUNDLE_HASH,
    openclawVersion: "2026.7.2",
    protocolFeatures: [],
  };
  const sshEndpoint: WorkerSshEndpoint = {
    host: "worker.example.test",
    port: 22,
    user: "worker",
    hostKey: HOST_KEY,
    keyRef: { source: "file", provider: "worker-keys", id: "/key" },
  };
  const environmentBase = {
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot,
    provisionOperationId: "provision-1",
    bootstrapReceipt,
    teardownTerminalState: null,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    leaseId: "lease-1",
    sshEndpoint,
  };
  const ready = {
    ...environmentBase,
    state: "ready",
    ownerEpoch: 1,
    attachedSessionIds: [],
    tunnelStatus: "connected",
  } satisfies DispatchEnvironmentRecord;
  const attached = {
    ...environmentBase,
    state: "attached",
    ownerEpoch: 2,
    attachedSessionIds: [REQUEST.sessionId],
    tunnelStatus: "connected",
  } satisfies DispatchEnvironmentRecord;
  let currentEnvironment: ReturnType<WorkerDispatchEnvironmentService["get"]> = ready;
  const destroyedEnvironment = (ownerEpoch: number): DispatchEnvironmentRecord => ({
    ...environmentBase,
    state: "destroyed",
    ownerEpoch,
    attachedSessionIds: [],
    tunnelStatus: "stopped",
  });
  const tunnelHandle = (ownerEpoch: number): WorkerTunnelHandle => ({
    environmentId: ready.environmentId,
    ownerEpoch,
    remoteSocketPath: "/worker/gateway.sock",
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
    resolveWorkspacePath: async () => {
      fail("workspace");
      return "/gateway/workspace";
    },
  });
  return {
    log,
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
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
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
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
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
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
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
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
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
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
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
