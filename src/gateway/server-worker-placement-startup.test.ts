import { describe, expect, it, vi } from "vitest";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
  resolveSessionEvidence: vi.fn(),
}));
const moveDestinationMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  findManagedWorktree: vi.fn(() => ({
    id: "worktree-recovery",
    ownerId: "agent:main:move-source",
    path: "/gateway/workspace",
  })),
  resolveCanonicalSession: vi.fn(() => ({
    sessionId: "session-recovery",
    worktree: { id: "worktree-recovery" },
  })),
  resolveExecutionMode: vi.fn(() => "remote-exec"),
  resolveGatewaySessionTarget: vi.fn(() => ({
    agentId: "main",
    canonicalKey: "agent:main:move-source",
    store: {},
    storeKeys: ["agent:main:move-source"],
    storePath: "/tmp/openclaw-worker-placement-session.sqlite",
  })),
  resolveSessionRuntime: vi.fn(() => "codex"),
  resolveSessionTarget: vi.fn(() => ({
    config: {},
    entry: {},
    target: { agentId: "main", canonicalKey: "agent:main:move-source" },
    worktree: { path: "/gateway/workspace" },
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: moveDestinationMocks.getRuntimeConfig };
});

vi.mock("./server-worker-placement-session-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-worker-placement-session-target.js")>();
  return {
    ...actual,
    resolveWorkerPlacementSessionTarget: moveDestinationMocks.resolveSessionTarget,
  };
});

vi.mock("./worker-environments/placement-session-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-session-runtime.js")>();
  return {
    ...actual,
    resolveWorkerPlacementExecutionMode: moveDestinationMocks.resolveExecutionMode,
    resolveWorkerPlacementSessionRuntime: moveDestinationMocks.resolveSessionRuntime,
  };
});

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    resolveCanonicalSessionEntryFromStoreKeys: moveDestinationMocks.resolveCanonicalSession,
    resolveGatewaySessionStoreTargetWithStore: moveDestinationMocks.resolveGatewaySessionTarget,
  };
});

vi.mock("../agents/worktrees/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/worktrees/service.js")>();
  return {
    ...actual,
    managedWorktrees: {
      findLiveByOwner: moveDestinationMocks.findManagedWorktree,
    },
  };
});

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>();
  return {
    ...actual,
    createWorkerPlacementDispatchService: runtimeFactoryMocks.createDispatch,
  };
});

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
import { createWorkerPlacementMoveService } from "./worker-environments/placement-move-service.js";

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

  it("drains deferred startup session evidence before stopping environments", async () => {
    const evidence = createDeferredCore<"current">();
    runtimeFactoryMocks.resolveSessionEvidence.mockImplementation(async () => evidence.promise);
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(
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
      reconcileActive: vi.fn().mockResolvedValue(undefined),
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
    let closeStarted = false;
    let sidecar: { stop: () => Promise<void> } | undefined;
    const unregisterSidecar = vi.fn();
    const starting = runtime.startRuntime({
      isClosePreludeStarted: () => closeStarted,
      registerSidecar: (registered) => {
        sidecar = registered;
      },
      unregisterSidecar,
    });
    await vi.waitFor(() => expect(runtimeFactoryMocks.resolveSessionEvidence).toHaveBeenCalled());
    closeStarted = true;
    const stopping = sidecar?.stop();
    const repeatedStop = sidecar?.stop();
    if (!stopping || !repeatedStop) {
      throw new Error("startup did not register its placement sidecar");
    }
    let repeatedStopSettled = false;
    void repeatedStop.then(() => {
      repeatedStopSettled = true;
    });

    await Promise.resolve();
    expect(repeatedStop).toBe(stopping);
    expect(repeatedStopSettled).toBe(false);
    expect(environments.stopNodeEnrollmentWaits).toHaveBeenCalledOnce();
    expect(environments.stop).not.toHaveBeenCalled();
    evidence.resolve("current");
    await expect(starting).resolves.toBeNull();
    await Promise.all([stopping, repeatedStop]);
    expect(environments.stop).toHaveBeenCalledOnce();
    expect(unregisterSidecar).toHaveBeenCalledOnce();
    expect(unregisterSidecar).toHaveBeenCalledWith(sidecar);
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

describe("worker placement move destination", () => {
  it("rejects a remote-exec paired-device move before reclaiming the active source", async () => {
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
    createGatewayWorkerPlacementRuntime({
      placements: { workspaceResultInstanceId: () => "gateway-test" } as never,
      environments: {} as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as
      | {
          resolveMoveDestination: Parameters<
            typeof createWorkerPlacementMoveService
          >[0]["resolveDestination"];
        }
      | undefined;
    if (!dispatchOptions) {
      throw new Error("worker placement dispatch options were not captured");
    }
    const runMoveBarrier = vi.fn(async () => {
      throw new Error("source placement barrier started");
    });
    const reclaimSource = vi.fn();
    const dispatch = vi.fn();
    const moves = createWorkerPlacementMoveService({
      placements: { getPlacementMove: () => undefined } as never,
      environments: { get: () => undefined },
      runMoveBarrier,
      dispatch,
      reclaimSource,
      resolveDestination: dispatchOptions.resolveMoveDestination,
    });

    await expect(
      moves.move({
        sessionId: "session-move-source",
        sessionKey: "agent:main:move-source",
        agentId: "main",
        source: { generation: 4, environmentId: "environment-source", ownerEpoch: 2 },
        target: { kind: "device", deviceId: "paired-build-mac" },
      }),
    ).rejects.toThrow(
      'runtime codex cannot move to a paired device; select an agent/model route with agentRuntime.id "openclaw" (the embedded runtime), or move to an SSH-backed cloud worker provider',
    );
    expect(runMoveBarrier).not.toHaveBeenCalled();
    expect(reclaimSource).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
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
