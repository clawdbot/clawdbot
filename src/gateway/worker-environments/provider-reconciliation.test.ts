import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-force-abandon.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("adopts a matching milestone-1 row that predates worker credentials", async () => {
    const environmentId = "worker-milestone-one";
    support.seedReady(environmentId);
    support.testState.stateDb.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(environmentId);
    support.testState.stateDb.db
      .prepare("UPDATE worker_environments SET owner_epoch = 0 WHERE environment_id = ?")
      .run(environmentId);
    const workerService = support.createService(
      support.createProvider({
        inspect: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    await workerService.reconcileOnce();

    expect(support.testState.store.get(environmentId)?.ownerEpoch).toBe(1);
    expect(support.testState.store.getCredential(environmentId)).toMatchObject({
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(
      workerService.takeMintedCredential({ environmentId, ownerEpoch: 1, sessionId: null }),
    ).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
    });
    expect(support.testState.store.get(environmentId)?.lastError).toBe("provider unavailable");
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("inspects a persisted lease with its profile snapshot after profile removal", async () => {
    support.seedBootstrapping("worker-crash");
    support.testState.config.cloudWorkers!.profiles = {};
    const inspected: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        return { status: "active" };
      },
      provision: async () => {
        throw new Error("provision must not run for a known lease");
      },
    });

    await support.createService(provider).reconcileOnce();

    expect(inspected).toEqual([{ leaseId: "lease:worker-crash", profile: { region: "test" } }]);
    expect(support.testState.store.get("worker-crash")).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("reconciles one exact environment without sweeping its siblings", async () => {
    support.seedReady("worker-target");
    support.seedReady("worker-sibling");
    const inspected: string[] = [];
    const workerService = support.createService(
      support.createProvider({
        inspect: async (lease) => {
          inspected.push(lease.leaseId);
          return { status: "active" };
        },
      }),
    );

    await workerService.reconcileEnvironment("worker-target");

    expect(inspected).toEqual(["lease:worker-target"]);
  });

  it("targeted reconciliation revokes a disappeared worker credential", async () => {
    const environmentId = "worker-revoked";
    support.seedReady(environmentId);
    const workerService = support.createService(
      support.createProvider({ inspect: async () => ({ status: "unknown" }) }),
    );
    const admitted = await workerService.admitWorker(support.admissionFor(environmentId));
    if (!admitted.ok) {
      throw new Error("fixture worker admission failed");
    }

    await workerService.reconcileEnvironment(environmentId);

    expect(support.testState.store.get(environmentId)?.state).toBe("orphaned");
    expect(workerService.validateWorkerConnection(admitted.identity)).toBe("credential-replaced");
  });

  it("skips an active lease whose durable receipt matches the lifecycle bundle", async () => {
    support.seedReady("worker-current");

    await support.createService(support.createProvider()).reconcileOnce();

    expect(support.testState.store.get("worker-current")).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("re-enters bootstrapping when the durable receipt has a stale bundle hash", async () => {
    const bootstrapping = support.seedBootstrapping("worker-stale");
    support.testState.store.transition({
      environmentId: bootstrapping.environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(bootstrapping.environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });

    await support.createService(support.createProvider()).reconcileOnce();

    expect(support.testState.store.get("worker-stale")).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1);
  });

  it("tears down an attached worker whose admitted bundle is stale", async () => {
    const environmentId = "worker-attached-stale";
    support.seedBootstrapping(environmentId);
    const ready = support.testState.store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });
    support.testState.store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: support.attachedPatch(environmentId, "session-1"),
    });
    const destroy = vi.fn(async () => {});

    await support.createService(support.createProvider({ destroy })).reconcileOnce();

    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith({
      leaseId: `lease:${environmentId}`,
      profile: { region: "test" },
    });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      attachedSessionIds: [],
      lastError: STALE_WORKER_BUILD_REASON,
    });
  });

  it("retires a node environment whose installed Gateway bundle is stale", async () => {
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provisionBeforeInstallation: true,
      provision: async () => ({
        leaseId: "device-lease-stale",
        node: { deviceId: "device-1" },
        sharedHost: true,
      }),
      inspect: async () => ({ status: "active", sharedHost: true }),
      destroy,
    });
    const workerService = support.createService(provider, {
      ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
    });
    const environment = await workerService.create("development", "request-stale-node-bundle");
    await workerService.attachSession({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: "session-stale-node-bundle",
    });
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environments SET bootstrap_bundle_hash = ?, bootstrap_install_kind = 'local' WHERE environment_id = ?",
      )
      .run("b".repeat(64), environment.environmentId);

    await workerService.reconcileOnce();

    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.get(environment.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      attachedSessionIds: [],
      lastError: STALE_WORKER_BUILD_REASON,
    });
  it("rechecks the placement teardown fence after stale-bundle preparation", async () => {
    const environmentId = "worker-attached-stale-pending-result";
    support.seedBootstrapping(environmentId);
    const ready = support.testState.store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "b".repeat(64),
      }),
    });
    support.testState.store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: support.attachedPatch(environmentId, "session-1"),
    });
    let fenced = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      fenced = true;
      return support.BUNDLE_ARTIFACT;
    });
    const placementStore = {
      hasWorkerTurn: vi.fn(() => false),
      isEnvironmentTeardownFenced: vi.fn(() => fenced),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(),
    };
    const destroy = vi.fn(async () => {});

    await support
      .createService(support.createProvider({ destroy }), { placementStore })
      .reconcileOnce();

    expect(placementStore.isEnvironmentTeardownFenced).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-1"],
    });
  });

  it("persists provider-owned host isolation while placement teardown is fenced", async () => {
    const environmentId = "worker-fenced-isolation-change";
    support.seedReady(environmentId, undefined, false);
    const placementStore = {
      hasWorkerTurn: vi.fn(() => false),
      isEnvironmentTeardownFenced: vi.fn(() => true),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(),
    };
    const stop = vi.fn(async () => {
      expect(support.testState.store.get(environmentId)?.sharedHost).toBe(false);
    });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      inspect: async () => ({ status: "active", sharedHost: true }),
    });

    await support.createService(provider, { placementStore, tunnelManager }).reconcileOnce();

    expect(stop).toHaveBeenCalledWith(environmentId, undefined);
    expect(support.testState.store.get(environmentId)?.sharedHost).toBe(true);
  });

  it.each([
    { status: "destroyed" as const, expectedState: "failed" },
    { status: "unknown" as const, expectedState: "orphaned" },
  ])(
    "projects provider-reported $status loss while placement teardown is fenced",
    async ({ status, expectedState }) => {
      const environmentId = `worker-fenced-${status}`;
      const ready = support.seedReady(environmentId);
      support.testState.store.transition({
        environmentId,
        from: ready.state,
        to: "attached",
        patch: support.attachedPatch(environmentId, "session-1"),
      });
      const placementStore = {
        hasWorkerTurn: vi.fn(() => false),
        isEnvironmentTeardownFenced: vi.fn(() => true),
        validateWorkerTurn: vi.fn(() => false),
        isWorkerTurnToolAuthorized: vi.fn(() => false),
        updateAckCursors: vi.fn(),
      };
      const inspect = vi.fn(async () => ({ status }));
      const destroy = vi.fn(async () => {});

      await support
        .createService(support.createProvider({ inspect, destroy }), { placementStore })
        .reconcileOnce();

      expect(inspect).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(environmentId)?.state).toBe(expectedState);
    },
  );

  it("lets the exact accepted placement owner destroy through the real service fence", async () => {
    const environmentId = "worker-attached-owned-result";
    const ready = support.seedReady(environmentId);
    const attached = support.testState.store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const active = seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    if (active.state !== "active") {
      throw new Error("expected active placement owner");
    }
    const claim = placements.claimReclaimWorkspaceResult({
      ...REQUEST,
      claimId: "reclaim-owned-result",
      runId: "reclaim-owned-result",
      owner: {
        kind: "worker",
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      },
    });
    placements.acceptWorkspaceResult(claim);
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }), {
      placementStore: createWorkerSessionPlacementGate(placements),
    });

    await expect(workerService.destroy(environmentId)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.get(environmentId)?.state).toBe("attached");
    const authorizeTeardown = vi.fn(() => placements.canDestroyAcceptedWorkspaceResult(claim));
    await expect(
      workerService.destroyOwned(environmentId, authorizeTeardown),
    ).resolves.toMatchObject({ state: "destroyed" });

    expect(authorizeTeardown.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      placements.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true }),
    ).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("retries force-abandoned teardown through the real service fence", async () => {
    const environmentId = "worker-force-abandoned-retry";
    const ready = support.seedReady(environmentId);
    const attached = support.testState.store.transition({
      environmentId,
      from: ready.state,
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const active = seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    if (active.state !== "active") {
      throw new Error("expected active placement owner");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    placements.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "f".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"f".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    placements.retainWorkspaceReconciliationForForcedAbandonment(owner);
    const draining = placements.startDrain({
      sessionId: active.sessionId,
      environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = placements.startReconcile({
      sessionId: active.sessionId,
      environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const failed = placements.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    });
    if (failed.state !== "failed") {
      throw new Error("expected failed force-abandoned placement");
    }

    let providerFails = true;
    const destroy = vi.fn(async () => {
      if (providerFails) {
        throw new Error("provider teardown timed out");
      }
    });
    const workerService = support.createService(support.createProvider({ destroy }), {
      placementStore: createWorkerSessionPlacementGate(placements),
    });
    await expect(
      workerService.destroyOwned(environmentId, () =>
        placements.canDestroyForceAbandonedEnvironment(environmentId),
      ),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.get(environmentId)?.state).toBe("destroying");

    providerFails = false;
    const failure = createPlacementFailureActions({ placements, environments: workerService });
    await failure.retryFailedTeardown(failed);

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
    expect(placements.listWorkspaceReconciliationOwners()).toEqual([owner]);
  });

  it("does not resolve npm while an admitted receipt matches the local bundle", async () => {
    const environmentId = "worker-current-npm";
    support.seedReady(environmentId, "npm");
    support.testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return support.BUNDLE_ARTIFACT;
      }
      throw new Error("npm registry is unavailable");
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    await workerService.reconcileOnce();

    expect(support.testState.prepareInstallation).toHaveBeenCalledTimes(1);
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
    expect(destroy).not.toHaveBeenCalled();
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "ready",
      leaseId: `lease:${environmentId}`,
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
      lastError: null,
    });
  });

  it("keeps an admitted lease retryable when local bundle identity is unavailable", async () => {
    const environmentId = "worker-current-bundle-unavailable";
    support.seedReady(environmentId, "npm");
    const attachedId = "worker-attached-bundle-unavailable";
    support.seedReady(attachedId);
    support.testState.store.transition({
      environmentId: attachedId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(attachedId, "session-1"),
    });
    support.testState.stateDb.db
      .prepare("DELETE FROM worker_environment_credentials WHERE environment_id = ?")
      .run(attachedId);
    support.testState.prepareInstallation = vi.fn(async () => {
      throw new Error("local bundle identity is unavailable");
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "ready",
      leaseId: `lease:${environmentId}`,
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
      lastError: "local bundle identity is unavailable",
    });
    expect(support.testState.store.getCredential(attachedId)).toBeUndefined();
    expect(
      workerService.takeMintedCredential({
        environmentId: attachedId,
        ownerEpoch: 2,
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it.each(["bootstrapping", "ready", "idle"] as const)(
    "tears down a persisted %s lease when mismatched npm preparation fails",
    async (state) => {
      const environmentId = `worker-prepare-${state}`;
      const bootstrapping = support.seedBootstrapping(environmentId, "npm");
      if (state !== "bootstrapping") {
        const ready = support.testState.store.transition({
          environmentId,
          from: bootstrapping.state,
          to: "ready",
          patch: support.readyPatch(environmentId, {
            ...support.BOOTSTRAP_RECEIPT,
            bundleHash: "c".repeat(64),
          }),
        });
        if (state === "idle") {
          support.testState.store.transition({ environmentId, from: ready.state, to: "idle" });
        }
      }
      support.testState.prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle") {
          return support.BUNDLE_ARTIFACT;
        }
        throw new Error("released npm artifact is unavailable");
      });
      const order: string[] = [];
      const tunnelManager = {
        status: () => "connected" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {
          order.push("tunnel-stop");
        }),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const destroy = vi.fn(async () => {
        order.push("provider-destroy");
      });

      await support
        .createService(support.createProvider({ destroy }), { tunnelManager })
        .reconcileOnce();

      expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
      expect(destroy).toHaveBeenCalledWith({
        leaseId: `lease:${environmentId}`,
        profile: { region: "test" },
      });
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        sshEndpoint: null,
        teardownTerminalState: "failed",
        lastError: "released npm artifact is unavailable",
      });
      expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
      expect(support.testState.prepareInstallation).toHaveBeenCalledWith("npm");
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    },
  );

  it("retries indeterminate teardown after a reconcile preparation failure and restart", async () => {
    const environmentId = "worker-prepare-teardown-retry";
    const bootstrapping = support.seedBootstrapping(environmentId, "npm");
    support.testState.store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        bundleHash: "c".repeat(64),
      }),
    });
    support.testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "bundle") {
        return support.BUNDLE_ARTIFACT;
      }
      throw new Error("released npm artifact is unavailable");
    });
    let teardownFails = true;
    const destroy = vi.fn(async () => {
      if (teardownFails) {
        throw new Error("provider teardown timed out");
      }
    });
    const provider = support.createProvider({ destroy });
    const workerService = support.createService(provider);

    await workerService.reconcileOnce();
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroying",
      leaseId: `lease:${environmentId}`,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });

    await workerService.stop();
    teardownFails = false;
    await support.createService(provider).reconcileOnce();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "released npm artifact is unavailable",
    });
  });

  it("uses the snapshotted npm selection after live config changes", async () => {
    support.getDevelopmentProfile().install = "npm";
    const provider = support.createProvider({
      provision: async () => {
        support.getDevelopmentProfile().install = "bundle";
        return { leaseId: "lease-npm", ssh: support.SSH_ENDPOINT };
      },
    });

    const result = await support.createService(provider).create("development", "request-npm");

    expect(result).toMatchObject({
      state: "ready",
      profileSnapshot: { install: "npm" },
    });
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("npm");
    expect(support.testState.bootstrapWorker).toHaveBeenCalledWith({
      operationId: result.provisionOperationId,
      sshEndpoint: support.SSH_ENDPOINT,
      installation: support.NPM_ARTIFACT,
      resolveIdentity: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  it("orphans unknown active leases and adopts unknown expected teardown", async () => {
    support.seedReady("worker-unknown");
    support.seedReady("worker-transient");
    support.seedReady("worker-destroyed-unknown");
    support.testState.store.requestDestroy({
      environmentId: "worker-destroyed-unknown",
      state: "ready",
    });
    support.testState.store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "ready",
      to: "draining",
    });
    support.testState.store.transition({
      environmentId: "worker-destroyed-unknown",
      from: "draining",
      to: "destroying",
    });
    const provider = support.createProvider({
      inspect: async ({ leaseId }) => {
        if (leaseId !== "lease:worker-transient") {
          return { status: "unknown" };
        }
        throw new Error("provider temporarily unavailable");
      },
    });
    const failedTunnelStops = new Set<string>();
    const tunnelManager = {
      start: vi.fn(),
      stop: vi.fn(async (environmentId: string) => {
        if (!failedTunnelStops.has(environmentId)) {
          failedTunnelStops.add(environmentId);
          throw new Error("tunnel stop interrupted");
        }
      }),
      stopAll: vi.fn(async () => {}),
      status: () => "connected" as const,
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(provider, { tunnelManager });
    const admitted = await workerService.admitWorker(support.admissionFor("worker-unknown"));
    if (!admitted.ok) {
      throw new Error("fixture worker admission failed");
    }

    await workerService.reconcileOnce();

    expect(support.testState.store.get("worker-unknown")?.state).toBe("draining");
    expect(support.testState.store.get("worker-destroyed-unknown")?.state).toBe("destroying");
    expect(workerService.validateWorkerConnection(admitted.identity)).toBe("credential-replaced");
    expect(support.testState.store.get("worker-transient")).toMatchObject({
      state: "ready",
      lastError: "provider temporarily unavailable",
    });
    await workerService.reconcileOnce();
    expect(tunnelManager.stop).toHaveBeenCalledTimes(4);
    expect(support.testState.store.get("worker-unknown")?.state).toBe("orphaned");
    expect(support.testState.store.get("worker-destroyed-unknown")).toMatchObject({
      state: "destroyed",
    });
  });

  it("keeps a dormant paired-device lease in its nonterminal holding state", async () => {
    support.seedReady("worker-dormant");
    const destroy = vi.fn(async () => {});
    const tunnelManager = {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
      status: () => "stopped" as const,
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(
      support.createProvider({ inspect: async () => ({ status: "dormant" }), destroy }),
      { tunnelManager },
    );

    await workerService.reconcileOnce();
    await workerService.reconcileOnce();

    expect(support.testState.store.get("worker-dormant")).toMatchObject({ state: "ready" });
    expect(tunnelManager.stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { status: "future" },
    { status: "active", sharedHost: "yes" },
    { status: "dormant", sharedHost: true },
    { status: "unknown", sharedHost: true },
  ])("retains retryable state for malformed inspection result %#", async (inspection) => {
    support.seedReady("worker-malformed");
    const provider = support.createProvider({ inspect: async () => inspection as never });

    await support.createService(provider).reconcileOnce();

    expect(support.testState.store.get("worker-malformed")).toMatchObject({
      state: "ready",
      lastError: expect.stringContaining("invalid inspection"),
    });
  });

  it("records provider-proven teardown without local intent as a failure", async () => {
    support.seedReady("worker-destroyed-ready");
    support.seedReady("worker-destroyed-attached");
    support.testState.store.transition({
      environmentId: "worker-destroyed-attached",
      from: "ready",
      to: "attached",
      patch: support.attachedPatch("worker-destroyed-attached", "session-1"),
    });
    support.seedReady("worker-destroyed-draining");
    support.testState.store.transition({
      environmentId: "worker-destroyed-draining",
      from: "ready",
      to: "draining",
    });
    const provider = support.createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy: async () => {
        throw new Error("destroy must not run for provider-proven teardown");
      },
    });

    const workerService = support.createService(provider);
    await workerService.reconcileOnce();

    for (const environmentId of [
      "worker-destroyed-ready",
      "worker-destroyed-attached",
      "worker-destroyed-draining",
    ]) {
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "failed",
        attachedSessionIds: [],
        lastError: "Worker environment disappeared before teardown was requested",
      });
    }
  });

  it("adopts a provider-proven bootstrap teardown as failed after restart", async () => {
    const bootstrapping = support.seedBootstrapping("worker-bootstrap-teardown-crash");
    const requested = support.testState.store.requestDestroy({
      environmentId: bootstrapping.environmentId,
      state: bootstrapping.state,
      terminalState: "failed",
      lastError: "remote bootstrap failed",
    });
    const draining = support.testState.store.transition({
      environmentId: requested.environmentId,
      from: requested.state,
      to: "draining",
      patch: { lastError: requested.lastError },
    });
    support.testState.store.transition({
      environmentId: draining.environmentId,
      from: draining.state,
      to: "destroying",
      patch: { lastError: draining.lastError },
    });
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      inspect: async () => ({ status: "destroyed" }),
      destroy,
    });
    support.testState.providersEnabled = false;
    const workerService = support.createService(provider);

    await workerService.reconcileOnce();
    expect(support.testState.store.get(bootstrapping.environmentId)).toMatchObject({
      state: "destroying",
      lastError: "remote bootstrap failed",
    });

    support.testState.providersEnabled = true;
    await workerService.reconcileOnce();

    expect(destroy).not.toHaveBeenCalled();
    expect(support.testState.store.get(bootstrapping.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });
  });

  it("keeps a failed destroy retryable and makes completed destroy idempotent", async () => {
    support.seedReady("worker-destroy");
    support.testState.config.cloudWorkers!.profiles = {};
    let fail = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      destroy: async (lease) => {
        destroyed.push(lease);
        if (fail) {
          throw new Error("destroy timeout");
        }
      },
    });
    const workerService = support.createService(provider);

    await expect(workerService.destroy("worker-destroy")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.get("worker-destroy")).toMatchObject({
      state: "destroying",
      lastError: "destroy timeout",
    });

    fail = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.get("worker-destroy")).toMatchObject({ state: "destroyed" });
    await workerService.destroy("worker-destroy");
    expect(destroyed).toEqual([
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
      { leaseId: "lease:worker-destroy", profile: { region: "test" } },
    ]);
  });

  it("adopts an unpersisted provision result before destroying", async () => {
    const intent = support.testState.store.createIntent({
      environmentId: "worker-pending-destroy",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy",
    });
    support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      provision: async () => {
        expect(
          support.testState.store.get(intent.environmentId)?.destroyRequestedAtMs,
        ).not.toBeNull();
        return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });

    const result = await support.createService(provider).destroy(intent.environmentId);

    expect(result.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-1", profile: { region: "test" } }]);
  });

  it("retains teardown intent across an indeterminate provision failure", async () => {
    support.testState.prepareInstallation = vi.fn(async () => {
      throw new Error("bundle preparation must not block teardown adoption");
    });
    const intent = support.testState.store.createIntent({
      environmentId: "worker-pending-destroy-retry",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:pending-destroy-retry",
    });
    support.testState.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    let provisionFails = true;
    const destroyed: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      provision: async () => {
        if (provisionFails) {
          throw new Error("provision outcome unknown");
        }
        return { leaseId: "lease-retried", ssh: support.SSH_ENDPOINT };
      },
      destroy: async (lease) => void destroyed.push(lease),
    });
    const workerService = support.createService(provider);

    support.testState.providersEnabled = false;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.get(intent.environmentId)?.destroyRequestedAtMs).not.toBeNull();

    support.testState.providersEnabled = true;
    await expect(workerService.destroy(intent.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: expect.any(Number),
    });

    provisionFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.get(intent.environmentId)?.state).toBe("destroyed");
    expect(destroyed).toEqual([{ leaseId: "lease-retried", profile: { region: "test" } }]);
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
  });
});
