import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
}));

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>();
  return {
    ...actual,
    createWorkerPlacementDispatchService: runtimeFactoryMocks.createDispatch,
  };
});

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
      admitNewPlacements: true,
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
      expect(environments.stop).toHaveBeenCalledOnce();

      releaseReconcile.resolve();
      await stopping;

      expect(warn).toHaveBeenCalledWith("Worker disk-space sweep failed: probe transport failed");
      expect(environments.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
