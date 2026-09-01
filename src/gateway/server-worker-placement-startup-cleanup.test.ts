import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectSessionMaintenancePreserveKeys } from "../config/sessions/store-maintenance-preserve.js";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return {
    ...actual,
    createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
  };
});

import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { createPlacementFailureActions } from "./worker-environments/placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./worker-environments/placement-dispatch-recovery.js";
import { seedActivePlacement } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as workerEnvironmentSupport from "./worker-environments/service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

describe("worker placement startup cleanup ownership", () => {
  workerEnvironmentSupport.setupWorkerEnvironmentServiceSuite();

  it("defers workspace cleanup for 50 failed placements until the first background sweep", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
      now: () => workerEnvironmentSupport.testState.nowMs,
    });
    for (let index = 0; index < 50; index += 1) {
      const requested = placements.startDispatch({
        sessionId: `session-debris-${index}`,
        sessionKey: `agent:main:debris-${index}`,
        agentId: "main",
        executionMode: "worker-turn",
      });
      const provisioning = placements.transition({
        sessionId: requested.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: `worker-debris-${index}` },
      });
      placements.fail({
        sessionId: requested.sessionId,
        expectedGeneration: provisioning.generation,
        recoveryError: "worker admission deadline exceeded",
      });
    }
    const before = placements.list();
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider(),
    );
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const resolveWorkspacePath = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      return path.join(workerEnvironmentSupport.testState.root, sessionId);
    });
    const recovery = createPlacementRecoveryActions({
      placements,
      environments,
      failure: createPlacementFailureActions({ placements, environments }),
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      resolveWorkspacePath,
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => undefined,
    });
    const starting = recovery.reconcile("startup");
    let sweeping: Promise<void> | undefined;
    try {
      expect(
        await Promise.race([
          starting.then(() => "ready"),
          cleanupStarted.promise.then(() => "cleanup"),
        ]),
      ).toBe("ready");
      expect(resolveWorkspacePath).not.toHaveBeenCalled();
      await recovery.reconcileActive("worker-debris-0");
      expect(resolveWorkspacePath).not.toHaveBeenCalled();

      sweeping = recovery.reconcileActive();
      await cleanupStarted.promise;
      expect(resolveWorkspacePath).toHaveBeenCalledOnce();
      releaseCleanup.resolve();
      await sweeping;
      expect(resolveWorkspacePath).toHaveBeenCalledTimes(50);
      await recovery.reconcileActive();
      expect(resolveWorkspacePath).toHaveBeenCalledTimes(50);
      expect(placements.list()).toEqual(before);
    } finally {
      releaseCleanup.resolve();
      await starting;
      await sweeping;
    }
  });

  it.each([
    { retainedAuthority: "a local turn claim", claimLocalTurn: true },
    { retainedAuthority: "an active owner epoch", claimLocalTurn: false },
  ])(
    "never reaches worker providers during startup while a failed placement retains $retainedAuthority",
    async ({ claimLocalTurn }) => {
      const environmentId = "worker-startup-fenced";
      const provision = vi.fn(async () => ({
        leaseId: "lease-startup-fenced",
        ssh: workerEnvironmentSupport.SSH_ENDPOINT,
      }));
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const destroy = vi.fn(async () => {});
      const environments = workerEnvironmentSupport.createService(
        workerEnvironmentSupport.createProvider({ provision, inspect, destroy }),
      );
      const requestedEnvironment = workerEnvironmentSupport.testState.store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: "provision:startup-fenced",
      });
      workerEnvironmentSupport.testState.store.transition({
        environmentId,
        from: requestedEnvironment.state,
        to: "provisioning",
      });
      workerEnvironmentSupport.testState.store.requestDestroy({
        environmentId,
        state: "provisioning",
      });
      const placements = createWorkerSessionPlacementStore({
        database: workerEnvironmentSupport.testState.stateDb,
        now: () => workerEnvironmentSupport.testState.nowMs,
      });
      let failed;
      if (claimLocalTurn) {
        const identity = {
          sessionId: "session-startup-fenced",
          sessionKey: "agent:main:startup-fenced",
          agentId: "main",
        };
        placements.claimTurn({
          ...identity,
          owner: { kind: "local" },
          claimId: "startup-fenced-local-claim",
          runId: "startup-fenced-local-run",
        });
        const requested = placements.startDispatch({ ...identity, executionMode: "remote-exec" });
        failed = placements.fail({
          sessionId: requested.sessionId,
          expectedGeneration: requested.generation,
          recoveryError: "startup worker placement failed before its local claim was released",
        });
        // Current dispatch binds environments only after its local turn drains; preserve a
        // crash-era terminal environment reference in SQLite without fabricating record shapes.
        workerEnvironmentSupport.testState.stateDb.db
          .prepare("UPDATE worker_session_placements SET environment_id = ? WHERE session_id = ?")
          .run(environmentId, failed.sessionId);
        failed = placements.get(failed.sessionId);
      } else {
        const active = seedActivePlacement(placements, {
          environmentId,
          ownerEpoch: 1,
          executionMode: "remote-exec",
        });
        if (active.state !== "active") {
          throw new Error("startup authority fixture did not produce an active placement");
        }
        const draining = placements.startDrain({
          sessionId: active.sessionId,
          environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
        const reconciling = placements.startReconcile({
          sessionId: draining.sessionId,
          environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        failed = placements.fail({
          sessionId: reconciling.sessionId,
          expectedGeneration: reconciling.generation,
          recoveryError: "startup worker placement failed before its owner epoch was released",
        });
      }
      expect(failed).toMatchObject({
        state: "failed",
        environmentId,
        activeOwnerEpoch: claimLocalTurn ? null : 1,
        turnClaim: claimLocalTurn ? expect.objectContaining({ owner: "local" }) : null,
      });
      const failedSessionKey = failed?.sessionKey;
      if (!failedSessionKey) {
        throw new Error("failed placement fixture is missing its session key");
      }
      runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
      runtimeFactoryMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: vi.fn(() => 0),
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      const runtime = createGatewayWorkerPlacementRuntime({
        cancelSessionWork: vi.fn(async () => {}),
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        revokeSessionAuthority: vi.fn(),
        warn: vi.fn(),
      });
      const sidecar = await runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });
      try {
        expect(sidecar).not.toBeNull();
        expect(collectSessionMaintenancePreserveKeys()?.has(failedSessionKey)).toBe(true);
        await environments.reconcileOnce();
        expect(provision).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
          state: "provisioning",
          leaseId: null,
          destroyRequestedAtMs: expect.any(Number),
        });
        workerEnvironmentSupport.testState.store.transition({
          environmentId,
          from: "provisioning",
          to: "failed",
        });
        expect(collectSessionMaintenancePreserveKeys()?.has(failedSessionKey)).not.toBe(true);
      } finally {
        await sidecar?.stop();
      }
      expect(collectSessionMaintenancePreserveKeys()?.has(failedSessionKey)).not.toBe(true);
    },
  );

  it("becomes ready before failed-placement lease adoption and drains its exact teardown", async () => {
    const environmentId = "worker-startup-indeterminate";
    const operationId = "provision:startup-indeterminate";
    const releaseResolution = createDeferredCore();
    const resolutionStarted = createDeferredCore();
    const resolveAllocation = vi.fn(async () => {
      resolutionStarted.resolve();
      await releaseResolution.promise;
      return { leaseId: "lease-startup-adopted", sharedHost: false };
    });
    const provision = vi.fn();
    const destroy = vi.fn(async () => {});
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider({ provision, resolveAllocation, destroy }),
    );
    const intent = workerEnvironmentSupport.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: operationId,
    });
    workerEnvironmentSupport.testState.store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    workerEnvironmentSupport.testState.store.requestDestroy({
      environmentId,
      state: "provisioning",
    });
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
      now: () => workerEnvironmentSupport.testState.nowMs,
    });
    const requested = placements.startDispatch({
      sessionId: "session-startup-indeterminate",
      sessionKey: "agent:main:startup-indeterminate",
      agentId: "main",
      executionMode: "remote-exec",
    });
    const provisioning = placements.transition({
      sessionId: requested.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId },
    });
    const failed = placements.fail({
      sessionId: provisioning.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "startup worker placement failed",
    });
    expect(failed).toMatchObject({
      state: "failed",
      environmentId,
      turnClaim: null,
      activeOwnerEpoch: null,
    });
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    let registeredSidecar: { stop: () => Promise<void> } | undefined;
    const starting = runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: (sidecar) => {
        registeredSidecar = sidecar;
      },
      unregisterSidecar: vi.fn(),
    });

    try {
      const first = await Promise.race([
        starting.then((sidecar) => ({ kind: "ready" as const, sidecar })),
        resolutionStarted.promise.then(() => ({ kind: "resolution" as const })),
      ]);
      expect(first.kind).toBe("ready");
      if (first.kind !== "ready" || !first.sidecar) {
        throw new Error("worker startup did not reach readiness before provider adoption");
      }
      await resolutionStarted.promise;
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith({ region: "test" }, operationId);
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });

      let stopped = false;
      const stopping = first.sidecar.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(destroy).not.toHaveBeenCalled();

      releaseResolution.resolve();
      await stopping;

      expect(provision).not.toHaveBeenCalled();
      expect(workerEnvironmentSupport.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(workerEnvironmentSupport.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "lease-startup-adopted",
        profile: { region: "test" },
      });
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-startup-adopted",
      });
    } finally {
      releaseResolution.resolve();
      await starting.catch(() => undefined);
      await registeredSidecar?.stop();
    }
  });
});
