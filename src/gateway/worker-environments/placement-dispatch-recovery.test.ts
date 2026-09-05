import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker placement restart recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const createRecoveryService = (
    placements: ReturnType<typeof createWorkerSessionPlacementStore>,
    environments: ReturnType<typeof support.createService>,
  ) =>
    createWorkerPlacementDispatchService({
      placements,
      environments,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      runLocalBarrier: async ({ startDispatch }) => startDispatch(),
      runRecoveryBarrier: async ({ run }) => await run("/gateway/workspace"),
      runActivationBarrier: async ({ activate }) => activate(),
      runMoveBarrier: async ({ begin }) => begin(),
      resolveMoveDestination: async () => undefined,
      runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
      runReclaimBarrier: async ({ begin, reclaim }) => await reclaim("/gateway/workspace", begin()),
      runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
      resolveWorkspacePath: async () => "/gateway/workspace",
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => undefined,
    });

  it.each(["startup", "active"] as const)(
    "does not report successful reclaim while provider-loss teardown is pending during %s recovery",
    async (mode) => {
      support.testState.prepareInstallation = vi.fn(async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }));
      const destroy = vi.fn(async (): Promise<void> => {
        throw new Error("provider deletion unavailable");
      });
      const environments = support.createService(
        support.createProvider({ inspect: async () => ({ status: "unknown" }), destroy }),
      );
      const ready = await environments.create(
        "development",
        "provider-loss-cleanup",
        undefined,
        "remote-exec",
      );
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      seedActivePlacement(placements, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      const recovery = createRecoveryService(placements, environments);

      if (mode === "startup") {
        await recovery.reconcile("startup");
      } else {
        await recovery.reconcileActive(ready.environmentId);
      }

      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "destroying",
        leaseId: ready.leaseId,
        destroyRequestedAtMs: support.testState.nowMs,
      });
      await expect(recovery.reclaim(REQUEST)).rejects.toThrow("provider deletion unavailable");
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "failed",
        environmentId: ready.environmentId,
        recoveryError: expect.stringContaining("teardown failed"),
      });

      destroy.mockResolvedValue(undefined);
      await expect(recovery.reclaim(REQUEST)).resolves.toMatchObject({ state: "local" });
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      });
    },
  );

  it.each(["startup", "active"] as const)(
    "fences a destroy-requested attachment during %s recovery even when physical cleanup fails",
    async (mode) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements, { destroyFails: true });
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        nodeDeviceId: "revoked-node",
        destroyRequestedAtMs: 1_000,
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      vi.mocked(harness.environments.stopTunnel).mockRejectedValue(
        new Error("node role revoked before stop confirmation"),
      );
      harness.placements.seedActive(environment.ownerEpoch);

      if (mode === "startup") {
        await harness.service.reconcile("startup");
      } else {
        await harness.service.reconcileActive(environment.environmentId);
      }

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: environment.environmentId,
        activeOwnerEpoch: environment.ownerEpoch,
        recoveryError: expect.stringContaining("node role revoked before stop confirmation"),
      });
      expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      failure: "provider no longer supports the persisted execution mode",
      executionMode: "remote-exec",
      snapshotMode: "remote-exec",
      nodeBacked: true,
      providerSupportsMode: false,
      expectedError: "does not support remote-exec",
      sweep: false,
    },
    {
      failure: "persisted provisioning mode does not match placement authority",
      executionMode: "remote-exec",
      snapshotMode: "worker-turn",
      nodeBacked: true,
      providerSupportsMode: true,
      expectedError: "execution mode does not match",
      sweep: false,
    },
    {
      failure: "worker-turn placement has an SSH lease",
      executionMode: "worker-turn",
      snapshotMode: "worker-turn",
      nodeBacked: false,
      providerSupportsMode: true,
      expectedError: "requires a node lease",
      sweep: false,
    },
    {
      failure: "runtime sweep observes a changed provider execution mode",
      executionMode: "remote-exec",
      snapshotMode: "remote-exec",
      nodeBacked: true,
      providerSupportsMode: false,
      expectedError: "does not support remote-exec",
      sweep: true,
    },
  ] as const)("fences active restart recovery when $failure", async (scenario) => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const environment = {
      ...harness.attached,
      providerId: "durable-provider",
      profileSnapshot: {
        ...harness.attached.profileSnapshot,
        executionMode: scenario.snapshotMode,
      },
      ...(scenario.nodeBacked ? { nodeDeviceId: "durable-node", sshEndpoint: null } : {}),
    };
    vi.mocked(harness.environments.get).mockReturnValue(environment);
    Object.assign(harness.environments, {
      supportsProviderExecutionMode: vi.fn(() => scenario.providerSupportsMode),
    });
    harness.placements.seedActive(environment.ownerEpoch, scenario.executionMode);

    if (scenario.sweep) {
      await harness.service.reconcileActive(environment.environmentId);
    } else {
      await harness.service.reconcile();
    }

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining(scenario.expectedError),
    });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
    expect(harness.log).not.toContain("placement:adopted");
  });

  it.each([
    { transport: "node", nodeBacked: true },
    { transport: "SSH", nodeBacked: false },
  ] as const)(
    "adopts an exact remote-exec $transport lease from its durable provider after profile changes",
    async ({ nodeBacked }) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements);
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        providerId: "durable-provider",
        profileSnapshot: {
          ...harness.attached.profileSnapshot,
          executionMode: "remote-exec" as const,
        },
        ...(nodeBacked ? { nodeDeviceId: "durable-node", sshEndpoint: null } : {}),
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      const supportsProviderExecutionMode = vi.fn(() => true);
      const supportsExecutionMode = vi.fn(() => false);
      Object.assign(harness.environments, {
        supportsExecutionMode,
        supportsProviderExecutionMode,
      });
      harness.placements.seedActive(environment.ownerEpoch, "remote-exec");

      await harness.service.reconcile();

      expect(harness.placements.current()).toMatchObject({
        state: "active",
        executionMode: "remote-exec",
      });
      expect(supportsProviderExecutionMode).toHaveBeenCalledWith("durable-provider", "remote-exec");
      expect(supportsExecutionMode).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      if (nodeBacked) {
        expect(harness.environments.startTunnel).not.toHaveBeenCalled();
      } else {
        expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { creation: "profile", matchingEnvironmentExists: true },
    { creation: "inherited", matchingEnvironmentExists: true },
    { creation: "profile", matchingEnvironmentExists: false },
  ] as const)(
    "never tears down an unrelated environment returned by $creation creation (expected owner exists: $matchingEnvironmentExists)",
    async ({ creation, matchingEnvironmentExists }) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements);
      const unrelatedEnvironment = {
        ...harness.attached,
        environmentId: "worker-unrelated-active",
        ownerEpoch: 91,
        attachedSessionIds: ["session-unrelated"],
      };
      vi.mocked(harness.environments.create).mockResolvedValue(unrelatedEnvironment);
      vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue(
        unrelatedEnvironment,
      );
      vi.mocked(harness.environments.get).mockImplementation((environmentId) => {
        if (environmentId === unrelatedEnvironment.environmentId) {
          return unrelatedEnvironment;
        }
        return matchingEnvironmentExists && environmentId === harness.ready.environmentId
          ? harness.ready
          : undefined;
      });
      const request =
        creation === "inherited"
          ? {
              ...REQUEST,
              inheritedProfile: {
                providerId: "fake",
                profileSnapshot: { install: "bundle" as const, settings: { region: "parent" } },
              },
            }
          : REQUEST;

      await expect(harness.service.dispatch(request)).rejects.toThrow(
        "current execution-context contract",
      );

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: harness.ready.environmentId,
      });
      expect(harness.environments.attachSession).not.toHaveBeenCalled();
      expect(harness.environments.stopTunnel).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
        expect.anything(),
      );
      expect(harness.environments.destroy).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
      );
      if (matchingEnvironmentExists) {
        expect(harness.environments.stopTunnel).toHaveBeenCalledWith(
          harness.ready.environmentId,
          harness.ready.ownerEpoch,
        );
        expect(harness.environments.destroy).toHaveBeenCalledWith(harness.ready.environmentId);
      } else {
        expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      }
    },
  );

  it("resumes an authoritative provisioning placement through the canonical dispatch stages", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements);
    const provisioning = harness.placements.seedProvisioning();
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }
    harness.log.length = 0;

    await harness.service.resumeProvisioning(provisioning, async () => {
      harness.log.push("environment:reconcile");
    });

    expect(harness.placements.current()).toMatchObject({
      state: "active",
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: harness.attached.ownerEpoch,
      workerBundleHash: harness.ready.bootstrapReceipt?.bundleHash,
    });
    expect(harness.placements.current()!.generation).toBeGreaterThan(provisioning.generation);
    expect(harness.environments.create).not.toHaveBeenCalled();
    expect(harness.environments.attachSession).toHaveBeenCalledOnce();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.log).toContain("recovery-barrier");
    expect(harness.log).toContain("placement:syncing");
    expect(harness.log).toContain("placement:starting");
    expect(harness.log).toContain("placement:active");
    expect(harness.log).not.toContain("activation");
  });

  it("fences provisioning recovery before attachment when its durable execution mode differs", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements);
    const provisioning = harness.placements.seedProvisioning("remote-exec");
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }
    const environment = {
      ...harness.ready,
      profileSnapshot: { ...harness.ready.profileSnapshot, executionMode: "worker-turn" as const },
    };
    vi.mocked(harness.environments.get).mockReturnValue(environment);

    await harness.service.resumeProvisioning(provisioning, async () => {});

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("execution mode"),
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
  });

  it("fails a placement interrupted before its environment intent and permits redispatch", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements);
    const provisioning = harness.placements.seedProvisioning();
    vi.mocked(harness.environments.get).mockReturnValue(undefined);

    await harness.service.reconcile();

    const failed = harness.placements.current();
    expect(failed).toMatchObject({
      state: "failed",
      environmentId: provisioning.environmentId,
      recoveryError: expect.stringContaining("environment"),
    });
    expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    if (failed?.state !== "failed") {
      throw new Error("restart recovery did not fail the interrupted provisioning placement");
    }

    const redispatch = createHarness(placements, {
      environmentGeneration: failed.generation + 1,
    });
    const active = await redispatch.service.dispatch(REQUEST);

    expect(active).toMatchObject({
      state: "active",
      environmentId: redispatch.ready.environmentId,
    });
    expect(active.environmentId).not.toBe(provisioning.environmentId);
  });

  it.each(["requested", "provisioning", "bootstrapping", "ready", "idle"] as const)(
    "retains an exact replayable %s environment during provisioning recovery",
    async (state) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements);
      const provisioning = harness.placements.seedProvisioning();
      const environment =
        state === "requested" || state === "provisioning"
          ? {
              ...harness.ready,
              state,
              leaseId: null,
              sshEndpoint: null,
              bootstrapReceipt: null,
              sharedHost: null,
              tunnelStatus: "stopped" as const,
            }
          : state === "bootstrapping"
            ? { ...harness.ready, state, bootstrapReceipt: null }
            : { ...harness.ready, state };
      vi.mocked(harness.environments.get).mockReturnValue(environment);

      await harness.service.reconcile();

      expect(harness.placements.current()).toEqual(provisioning);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["destroy-requested", { destroyRequestedAtMs: 1_000 }],
    ["attached", { state: "attached" as const, attachedSessionIds: Array.of(REQUEST.sessionId) }],
    ["draining", { state: "draining" as const }],
    ["destroying", { state: "destroying" as const }],
    ["destroyed", { state: "destroyed" as const }],
    ["failed", { state: "failed" as const }],
    ["orphaned", { state: "orphaned" as const }],
    ["mismatched", { environmentId: "worker-different" }],
    ["missing receipt", { bootstrapReceipt: null }],
    [
      "legacy launch dialect",
      {
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.7.2",
          protocolFeatures: Array.of(WORKER_LAUNCH_V2_PROTOCOL_FEATURE),
        },
      },
    ],
  ] as const)("fails provisioning recovery for a %s environment", async (_kind, patch) => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements);
    harness.placements.seedProvisioning();
    const environment =
      "state" in patch && patch.state === "failed"
        ? {
            ...harness.ready,
            ...patch,
            leaseId: null,
            sshEndpoint: null,
            bootstrapReceipt: null,
            sharedHost: null,
            tunnelStatus: "stopped" as const,
          }
        : { ...harness.ready, ...patch };
    vi.mocked(harness.environments.get).mockReturnValue(environment);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it.each([
    ["session", "Session agent:main:session-1 changed before cloud worker recovery"],
    ["runtime", "Session agent:main:session-1 runtime changed before cloud worker recovery"],
    ["generation", "Session agent:main:session-1 placement generation changed before recovery"],
  ] as const)("tears down provisioning when %s authority changed", async (_kind, message) => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = createHarness(placements, {
      recoveryBarrierError: new Error(message),
    });
    const provisioning = harness.placements.seedProvisioning();
    if (provisioning.state !== "provisioning") {
      throw new Error("recovery fixture did not produce a provisioning placement");
    }

    await harness.service.resumeProvisioning(provisioning, async () => {});

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: message,
    });
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { timing: "before", change: "generation", state: "provisioning" },
    { timing: "before", change: "environment", state: "provisioning" },
    { timing: "before", change: "environment", state: "syncing" },
    { timing: "before", change: "environment", state: "starting" },
    { timing: "before", change: "session", state: "provisioning" },
    { timing: "after", change: "generation", state: "provisioning" },
    { timing: "after", change: "environment", state: "provisioning" },
    { timing: "after", change: "environment", state: "syncing" },
    { timing: "after", change: "environment", state: "starting" },
    { timing: "after", change: "session", state: "provisioning" },
  ] as const)(
    "never tears down a newer $state $change owner when recovery fails $timing its callback",
    async ({ change, state, timing }) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements);
      const original = harness.placements.seedProvisioning();
      if (original.state !== "provisioning" || !original.environmentId) {
        throw new Error("recovery fixture did not produce an owned provisioning placement");
      }
      const replacementEnvironmentId =
        change === "environment" ? "worker-newer-environment" : original.environmentId;
      const pendingEnvironment = {
        ...harness.ready,
        state: "provisioning" as const,
        leaseId: null,
        sshEndpoint: null,
        bootstrapReceipt: null,
        sharedHost: null,
        tunnelStatus: "stopped" as const,
      };
      vi.mocked(harness.environments.get).mockImplementation((environmentId) =>
        environmentId === original.environmentId
          ? pendingEnvironment
          : environmentId === replacementEnvironmentId
            ? { ...harness.ready, environmentId }
            : undefined,
      );
      let replacement: ReturnType<typeof placements.get>;
      const observedPlacements = {
        ...placements,
        get: (sessionId: string) => {
          const current = placements.get(sessionId);
          return change === "session" && replacement && current
            ? { ...current, sessionKey: "agent:main:replacement-session" }
            : current;
        },
      };
      const replacePlacement = () => {
        placements.fail({
          sessionId: original.sessionId,
          expectedGeneration: original.generation,
          recoveryError: "superseded placement",
        });
        const requested = placements.startDispatch(REQUEST);
        replacement = placements.transition({
          sessionId: original.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId: replacementEnvironmentId },
        });
        if (state === "syncing" || state === "starting") {
          replacement = placements.transition({
            sessionId: original.sessionId,
            from: "provisioning",
            to: "syncing",
            expectedGeneration: replacement.generation,
            patch: { workerBundleHash: BUNDLE_HASH },
          });
        }
        if (state === "starting") {
          replacement = placements.transition({
            sessionId: original.sessionId,
            from: "syncing",
            to: "starting",
            expectedGeneration: replacement.generation,
            patch: {
              workspaceBaseManifestRef: MANIFEST_REF,
              remoteWorkspaceDir: "/worker/newer-workspace",
            },
          });
        }
      };
      const startup = createWorkerPlacementDispatchStartup({
        placements: observedPlacements,
        environments: harness.environments,
        failure: createPlacementFailureActions({
          placements: observedPlacements,
          environments: harness.environments,
        }),
        runRecoveryBarrier: async ({ run }) => {
          if (timing === "after") {
            await run("/gateway/workspace");
          }
          replacePlacement();
          throw new Error("stale recovery lifecycle was replaced");
        },
        runActivationBarrier: async ({ activate }) => activate(),
        reportTransition: (observer, placement) => observer?.(placement),
      });

      await startup.resumeProvisioning(original, async () => {});

      expect(placements.get(original.sessionId)).toEqual(replacement);
      expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["attach", "tunnel:attached", "sync"] as const)(
    "tears down only its exact owned placement when recovery fails during %s",
    async (failAt) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 1_000,
      });
      const harness = createHarness(placements, { failAt });
      const provisioning = harness.placements.seedProvisioning();
      if (provisioning.state !== "provisioning") {
        throw new Error("recovery fixture did not produce a provisioning placement");
      }

      await harness.service.resumeProvisioning(provisioning, async () => {});

      expect(harness.placements.current()).toMatchObject({
        state: "failed",
        environmentId: provisioning.environmentId,
        recoveryError: expect.stringContaining("failed"),
      });
      expect(harness.environments.destroy).toHaveBeenCalledWith(provisioning.environmentId);
    },
  );

  it("does not recover a pending result through a worker with the legacy launch dialect", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const originalHarness = createHarness(placements);
    const active = originalHarness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = placements.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "legacy-worker-claim",
      runId: "legacy-worker-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 2_000,
    });
    const restartedHarness = createHarness(restartedStore);
    restartedHarness.markEnvironmentOwnerEpoch(2);
    restartedHarness.markEnvironmentProtocolFeatures([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]);

    await restartedHarness.service.reconcile();

    expect(restartedHarness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Pending cloud workspace result lost its worker: session-1",
    });
    expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
    expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it.each(["bundle", "provider"] as const)(
    "keeps stale pending recovery fenced when %s recovery is unavailable",
    async (failure) => {
      const currentReceipt: WorkerAdmissionHandshake = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      };
      let currentBundle: WorkerInstallationArtifact = {
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: currentReceipt.protocolFeatures,
      };
      const recoveryState = { started: false };
      support.testState.prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle" && recoveryState.started && failure === "bundle") {
          throw new Error("bundle unavailable");
        }
        return install === "bundle" ? currentBundle : support.NPM_ARTIFACT;
      });
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const provider = support.createProvider({
        inspect: async () => {
          if (recoveryState.started && failure === "provider") {
            throw new Error("provider unavailable");
          }
          return { status: "active" };
        },
      });
      const workerService = support.createService(provider, { tunnelManager });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const recovery = createRecoveryService(placements, workerService);
      const environmentId = "worker-stale-recovery";
      const bootstrapping = support.seedBootstrapping(environmentId);
      support.testState.store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: support.readyPatch(environmentId, currentReceipt),
      });
      const attached = await workerService.attachSession({
        environmentId,
        ownerEpoch: 1,
        sessionId: "session-1",
      });
      const active = seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "claim-stale-recovery",
        runId: "run-stale-recovery",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.markWorkspaceResultPending(claim);
      placements.handoffWorkspaceResultRecovery(claim);
      currentBundle = { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
      recoveryState.started = true;

      await recovery.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      expect(workerService.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(tunnelManager.start).not.toHaveBeenCalled();
    },
  );
});
