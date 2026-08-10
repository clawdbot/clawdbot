import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import {
  coordinateWorkerPlacementDispatch,
  type GatewayWorkerPlacementRuntime,
} from "./server-worker-placement-startup.js";
import type { WorkerPlacementDispatchRequest } from "./worker-environments/service-contract.js";

type DispatchService = GatewayWorkerPlacementRuntime["dispatchService"];

describe("worker placement dispatch coordinator", () => {
  it("forwards the optional internal transition observer", async () => {
    const request: WorkerPlacementDispatchRequest = {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      agentId: "main",
      profileId: "test",
    };
    const observer = vi.fn();
    const dispatch = vi.fn().mockResolvedValue({ state: "active" });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;

    await coordinateWorkerPlacementDispatch(service).dispatch(request, observer);

    expect(dispatch).toHaveBeenCalledWith(request, observer);
  });

  it("coalesces full sweeps but runs a fresh targeted pass with its environment id", async () => {
    const fullSweepStarted = createDeferred();
    const releaseFullSweep = createDeferred();
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
