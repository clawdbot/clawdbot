import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
  resolveSessionEvidence: vi.fn(),
}));
const moveDestinationMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveExecutionMode: vi.fn(() => "remote-exec"),
  resolveSessionRuntime: vi.fn(() => "codex"),
  resolveSessionTarget: vi.fn(() => ({
    config: {},
    entry: {},
    target: { agentId: "main", canonicalKey: "agent:main:move-source" },
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
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();
    const runtime = createGatewayWorkerPlacementRuntime({
      placements: {
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
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      placements: {
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
      start: vi.fn(),
      stop: vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined),
    };
    const runtime = createGatewayWorkerPlacementRuntime({
      placements: {
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
      placements: {} as never,
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
