import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
  resolveSessionEvidence: vi.fn(),
}));

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
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    let closeStarted = false;
    let sidecar: { stop: () => Promise<void> } | undefined;
    const starting = runtime.startRuntime({
      isClosePreludeStarted: () => closeStarted,
      registerSidecar: (registered) => {
        sidecar = registered;
      },
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
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
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
