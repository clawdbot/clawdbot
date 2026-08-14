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

import {
  coordinateWorkerPlacementDispatch,
  createGatewayWorkerPlacementRuntime,
  type GatewayWorkerPlacementRuntime,
} from "./server-worker-placement-startup.js";
import type { WorkerPlacementDispatchRequest } from "./worker-environments/service-contract.js";

type DispatchService = GatewayWorkerPlacementRuntime["dispatchService"];

const REQUEST: WorkerPlacementDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "test",
};

describe("worker placement dispatch coordinator", () => {
  it("forwards the optional internal transition observer", async () => {
    const observer = vi.fn();
    const dispatch = vi.fn().mockResolvedValue({ state: "active" });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;

    await coordinateWorkerPlacementDispatch(service).dispatch(REQUEST, observer);

    expect(dispatch).toHaveBeenCalledWith(REQUEST, observer);
  });

  it("coalesces an identical dispatch and rejects a conflicting in-flight request", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const active = { state: "active" };
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return active;
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const first = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    await expect(
      coordinated.dispatch({ ...REQUEST, profileId: "another-profile" }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    await expect(
      coordinated.dispatch({
        ...REQUEST,
        inheritedProfile: {
          providerId: "fake",
          profileSnapshot: { settings: { region: "parent" } },
        },
      }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const retry = coordinated.dispatch(REQUEST);
    releaseDispatch.resolve();

    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(retryResult).toBe(firstResult);
    expect(dispatch).toHaveBeenCalledOnce();

    await coordinated.dispatch({ ...REQUEST, profileId: "another-profile" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("joins a retry before a queued reconciliation after dispatch failure", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const dispatchError = new Error("provision failed");
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      throw dispatchError;
    });
    const reconcileActive = vi.fn();
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const first = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const reconciliation = coordinated.reconcileActive();
    const retry = coordinated.dispatch(REQUEST);
    const outcomes = Promise.allSettled([first, retry]);
    releaseDispatch.resolve();

    expect(await outcomes).toEqual([
      { status: "rejected", reason: dispatchError },
      { status: "rejected", reason: dispatchError },
    ]);
    await reconciliation;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(reconcileActive).toHaveBeenCalledOnce();

    await expect(coordinated.dispatch({ ...REQUEST, profileId: "another-profile" })).rejects.toBe(
      dispatchError,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("coalesces full sweeps but runs a fresh targeted pass with its environment id", async () => {
    const fullSweepStarted = createDeferredCore();
    const releaseFullSweep = createDeferredCore();
    const reconcileActive = vi.fn(async (environmentId?: string) => {
      if (environmentId === undefined) {
        fullSweepStarted.resolve();
        await releaseFullSweep.promise;
      }
    });
    const service = {
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const firstFullSweep = coordinated.reconcileActive();
    const secondFullSweep = coordinated.reconcileActive();
    await fullSweepStarted.promise;
    const targetedSweep = coordinated.reconcileActive("worker-target");

    expect(reconcileActive).toHaveBeenCalledTimes(1);
    releaseFullSweep.resolve();
    await Promise.all([firstFullSweep, secondFullSweep, targetedSweep]);

    expect(reconcileActive.mock.calls).toEqual([[], ["worker-target"]]);
  });
});

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
