import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

// Install the shared module mocks before any source imports can load the runtime.
const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();

import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

describe("worker placement startup health lifetime", () => {
  it("samples disk on schedule while reconciliation is stuck and drains both on stop", async () => {
    vi.useFakeTimers();
    const releaseReconcile = createDeferredCore();
    const releaseScheduledHealth = createDeferredCore();
    const healthError = new Error("probe transport failed");
    let healthSweepCount = 0;
    const diskSpace = {
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn(async () => {
        healthSweepCount += 1;
        if (healthSweepCount > 1) {
          await releaseScheduledHealth.promise;
        }
      }),
    };
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const reconcileActive = vi.fn(async () => await releaseReconcile.promise);
    runtimeFactoryMocks.createDiskSpace.mockReturnValue(diskSpace);
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive,
    });
    const environments = {
      installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => undefined,
        list: () => [],
        retireSessionPlacement: vi.fn(),
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn,
    });

    try {
      const sidecar = await runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });

      expect(sidecar).not.toBeNull();
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(diskSpace.sweep).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileActive).toHaveBeenCalledOnce();
      expect(diskSpace.sweep).toHaveBeenCalledTimes(2);

      let stopSettled = false;
      const stopping = sidecar!.stop().then(() => {
        stopSettled = true;
      });
      releaseScheduledHealth.reject(healthError);
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(environments.stop).not.toHaveBeenCalled();

      releaseReconcile.resolve();
      await stopping;

      expect(warn).toHaveBeenCalledWith("Worker disk-space sweep failed: probe transport failed");
      expect(environments.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["provisioning", "active"] as const)(
    "waits for %s placement authority recovery before exposing readiness",
    async (state) => {
      const releaseRecovery = createDeferredCore();
      const reconcile = vi.fn(async () => await releaseRecovery.promise);
      runtimeFactoryMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: vi.fn(() => 0),
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      runtimeFactoryMocks.createDispatch.mockReturnValue({
        dispatch: vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        reclaim: vi.fn(),
        reconcile,
        reconcileActive: vi.fn().mockResolvedValue(undefined),
      });
      runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
      const placement = {
        sessionId: `session-startup-${state}`,
        sessionKey: `agent:main:startup-${state}`,
        agentId: "main",
        state,
        generation: 1,
        environmentId: `worker-startup-${state}`,
        activeOwnerEpoch: state === "active" ? 1 : null,
        turnClaim: null,
      };
      const environments = {
        installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        cancelSessionWork: vi.fn(async () => {}),
        placements: {
          workspaceResultInstanceId: () => "gateway-test",
          get: () => placement,
          list: () => [placement],
          retireSessionPlacement: vi.fn(),
          pruneOrphanedWorkspaceReconciliations: () => [],
          listWorkspaceReconciliationOwners: () => [],
          listPendingWorkspaceResults: () => [],
        } as never,
        environments: environments as never,
        gatewayNamespace: "gateway-test",
        revokeSessionAuthority: vi.fn(),
        warn: vi.fn(),
      });
      const starting = runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });

      try {
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith("startup"));
        expect(environments.start).not.toHaveBeenCalled();

        let ready = false;
        void starting.then(() => {
          ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        releaseRecovery.resolve();
        const sidecar = await starting;
        expect(sidecar).not.toBeNull();
        expect(environments.start).toHaveBeenCalledOnce();
        await sidecar?.stop();
      } finally {
        releaseRecovery.resolve();
        await starting.catch(() => undefined);
      }
    },
  );

  it("immediately retires absent sessions after readiness and drains retirement on stop", async () => {
    const evidence = createDeferredCore<"absent">();
    const reconcileActive = vi.fn().mockResolvedValue(undefined);
    const retireSessionPlacement = vi.fn();
    runtimeFactoryMocks.resolveSessionEvidence.mockImplementationOnce(async () => evidence.promise);
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValueOnce(
      runtimeFactoryMocks.resolveSessionEvidence,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive,
    });
    const placement = {
      sessionId: "session-startup",
      sessionKey: "agent:main:startup",
      agentId: "main",
      state: "local",
      generation: 1,
      turnClaim: null,
      environmentId: null,
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
    } as const;
    const environments = {
      installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      stopNodeEnrollmentWaits: vi.fn(),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => placement,
        list: () => [placement],
        retireSessionPlacement,
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    let sidecar: { stop: () => Promise<void> } | undefined;
    const unregisterSidecar = vi.fn();
    try {
      const starting = runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: (registered) => {
          sidecar = registered;
        },
        unregisterSidecar,
      });
      await expect(starting).resolves.toBe(sidecar);
      expect(runtimeFactoryMocks.resolveSessionEvidence).toHaveBeenCalledOnce();
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(retireSessionPlacement).not.toHaveBeenCalled();

      const stopping = sidecar?.stop();
      const repeatedStop = sidecar?.stop();
      if (!stopping || !repeatedStop) {
        throw new Error("startup did not register its placement sidecar");
      }

      await Promise.resolve();
      expect(repeatedStop).toBe(stopping);
      expect(environments.stopNodeEnrollmentWaits).toHaveBeenCalledOnce();
      expect(environments.stop).not.toHaveBeenCalled();
      evidence.resolve("absent");
      await Promise.all([stopping, repeatedStop]);
      expect(retireSessionPlacement).toHaveBeenCalledOnce();
      expect(environments.stop).toHaveBeenCalledOnce();
      expect(unregisterSidecar).not.toHaveBeenCalled();
    } finally {
      evidence.resolve("absent");
      await sidecar?.stop();
    }
  });

  it("retries worker environment cleanup after a failed stop attempt", async () => {
    const stopError = new Error("tunnel cleanup failed");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive: vi.fn().mockResolvedValue(undefined),
    });
    const environments = {
      installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
      start: vi.fn(),
      stop: vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => undefined,
        list: () => [],
        retireSessionPlacement: vi.fn(),
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    if (!sidecar) {
      throw new Error("worker placement runtime did not start");
    }

    const firstStop = sidecar.stop();
    expect(sidecar.stop()).toBe(firstStop);
    await expect(firstStop).rejects.toBe(stopError);
    await expect(sidecar.stop()).resolves.toBeUndefined();

    expect(environments.stop).toHaveBeenCalledTimes(2);
  });

  it("routes environment reconciliation through one exact provisioning owner", async () => {
    type ReconcileGuard = (
      environmentId: string,
      reconcileCore: () => Promise<void>,
    ) => Promise<void>;
    let installedGuard: ReconcileGuard | undefined;
    let placementRows: Array<{
      sessionId: string;
      state: "active" | "provisioning";
      environmentId: string;
    }> = [];
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      await reconcileCore();
    });
    const reconcile = vi.fn(async () => {
      expect(installedGuard).toBeDefined();
    });
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn().mockResolvedValue(undefined),
      resumeProvisioning,
    });
    const environments = {
      get: vi.fn((environmentId: string) => ({ environmentId, state: "provisioning" })),
      installReconcileEnvironmentGuard: vi.fn((guard: ReconcileGuard) => {
        installedGuard = guard;
        return vi.fn();
      }),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => undefined,
        list: () => placementRows,
        retireSessionPlacement: vi.fn(),
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    const guard = installedGuard;
    if (!sidecar || !guard) {
      throw new Error("worker placement reconcile guard was not installed");
    }

    const provisioning = {
      sessionId: "session-guarded",
      state: "provisioning" as const,
      environmentId: "worker-guarded",
    };
    placementRows = [provisioning];
    const exactCore = vi.fn(async () => {});
    await guard(provisioning.environmentId, exactCore);
    expect(resumeProvisioning).toHaveBeenCalledWith(provisioning, exactCore);
    expect(exactCore).toHaveBeenCalledOnce();

    placementRows = [];
    const unrelatedCore = vi.fn(async () => {});
    await guard("worker-unrelated", unrelatedCore);
    expect(unrelatedCore).toHaveBeenCalledOnce();

    placementRows = [
      provisioning,
      { sessionId: "session-duplicate", state: "active", environmentId: "worker-guarded" },
    ];
    const ambiguousCore = vi.fn(async () => {});
    await expect(guard("worker-guarded", ambiguousCore)).rejects.toThrow(
      "multiple placement owners",
    );
    expect(ambiguousCore).not.toHaveBeenCalled();

    placementRows = [
      { sessionId: "session-mismatch", state: "active", environmentId: "worker-mismatch" },
    ];
    const mismatchedCore = vi.fn(async () => {});
    await expect(guard("worker-mismatch", mismatchedCore)).rejects.toThrow(
      "provisioning owner is active",
    );
    expect(mismatchedCore).not.toHaveBeenCalled();
    await sidecar.stop();
  });

  it("closes guarded recovery admission and drains it during environment stop", async () => {
    type ReconcileGuard = (
      environmentId: string,
      reconcileCore: () => Promise<void>,
    ) => Promise<void>;
    const recoveryStarted = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const environmentStopStarted = createDeferredCore();
    const events: string[] = [];
    let installedGuard: ReconcileGuard | undefined;
    const placement = {
      sessionId: "session-close-guard",
      state: "provisioning" as const,
      environmentId: "worker-close-guard",
    };
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive: vi.fn().mockResolvedValue(undefined),
      resumeProvisioning: vi.fn(async (_placement, reconcileCore) => {
        events.push("recovery:start");
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        await reconcileCore();
        events.push("recovery:end");
      }),
    });
    const environments = {
      get: vi.fn((environmentId: string) => ({ environmentId, state: "provisioning" })),
      installReconcileEnvironmentGuard: vi.fn((guard: ReconcileGuard) => {
        installedGuard = guard;
        return async () => {
          events.push("guard:uninstall");
          await guardedRecovery;
        };
      }),
      start: vi.fn(),
      stop: vi.fn(async () => {
        events.push("environments:stop");
        environmentStopStarted.resolve();
        await guardedRecovery;
      }),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => placement,
        list: () => [placement],
        retireSessionPlacement: vi.fn(),
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    const guard = installedGuard;
    if (!sidecar || !guard) {
      throw new Error("worker placement reconcile guard was not installed");
    }
    const reconcileCore = vi.fn(async () => {
      events.push("reconcile:core");
    });
    const guardedRecovery = guard(placement.environmentId, reconcileCore);
    await recoveryStarted.promise;

    const stopping = sidecar.stop();
    await environmentStopStarted.promise;
    const postCloseCore = vi.fn(async () => {});
    await guard("worker-after-close", postCloseCore);
    expect(postCloseCore).not.toHaveBeenCalled();
    expect(environments.stop).toHaveBeenCalledOnce();

    releaseRecovery.resolve();
    await Promise.all([guardedRecovery, stopping]);
    expect(events).toEqual([
      "recovery:start",
      "environments:stop",
      "reconcile:core",
      "recovery:end",
      "guard:uninstall",
    ]);
  });
});

describe("worker placement startup recovery authority", () => {
  it("holds exact session authority through async recovery work", async () => {
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      move: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    });
    const placement = {
      state: "provisioning",
      generation: 7,
      environmentId: "worker-recovery",
    };
    createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => placement,
      } as never,
      environments: {} as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as
      | {
          runRecoveryBarrier: (request: {
            sessionId: string;
            sessionKey: string;
            agentId: string;
            executionMode: "remote-exec";
            environmentId: string;
            expectedGeneration: number;
            run: (localPath: string) => Promise<void>;
          }) => Promise<void>;
        }
      | undefined;
    if (!dispatchOptions) {
      throw new Error("worker placement recovery barrier was not captured");
    }
    const request = {
      sessionId: "session-recovery",
      sessionKey: "agent:main:move-source",
      agentId: "main",
      executionMode: "remote-exec" as const,
      environmentId: placement.environmentId,
      expectedGeneration: placement.generation,
    };
    const releaseRecovery = createDeferredCore();
    const events: string[] = [];
    const recovery = dispatchOptions.runRecoveryBarrier({
      ...request,
      run: async (localPath) => {
        events.push(`recovery:${localPath}`);
        await releaseRecovery.promise;
        events.push("recovery:done");
      },
    });
    await vi.waitFor(() => expect(events).toEqual(["recovery:/gateway/workspace"]));
    const contender = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/openclaw-worker-placement-session.sqlite",
      identities: [
        request.sessionKey,
        "agent:main:move-source",
        "agent:main:move-source",
        request.sessionId,
      ],
      run: async () => {
        events.push("contender");
      },
    });
    await Promise.resolve();
    expect(events).toEqual(["recovery:/gateway/workspace"]);
    releaseRecovery.resolve();
    await Promise.all([recovery, contender]);
    expect(events).toEqual(["recovery:/gateway/workspace", "recovery:done", "contender"]);

    moveDestinationMocks.resolveExecutionMode.mockReturnValueOnce("worker-turn");
    await expect(
      dispatchOptions.runRecoveryBarrier({ ...request, run: async () => {} }),
    ).rejects.toThrow("runtime changed");

    await expect(
      dispatchOptions.runRecoveryBarrier({
        ...request,
        expectedGeneration: 8,
        run: async () => {},
      }),
    ).rejects.toThrow("placement changed");

    moveDestinationMocks.resolveCanonicalSession.mockReturnValueOnce({
      sessionId: "session-replaced",
      worktree: { id: "worktree-recovery" },
    });
    await expect(
      dispatchOptions.runRecoveryBarrier({ ...request, run: async () => {} }),
    ).rejects.toThrow("changed before cloud worker recovery");
  });
});
