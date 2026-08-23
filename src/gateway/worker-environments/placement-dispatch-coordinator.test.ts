import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementMoveRequest,
} from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

const REQUEST: WorkerPlacementDispatchRequest = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  agentId: "main",
  profileId: "test",
  executionMode: "worker-turn",
};

const MOVE_REQUEST: WorkerPlacementMoveRequest = {
  sessionId: REQUEST.sessionId,
  sessionKey: REQUEST.sessionKey,
  agentId: REQUEST.agentId,
  source: { generation: 4, environmentId: "worker-source", ownerEpoch: 7 },
  target: { kind: "gateway" },
};

describe("worker placement dispatch coordinator", () => {
  it("forwards in-process transition and authorization hooks outside request equality", async () => {
    const observer = vi.fn();
    const authorize = vi.fn();
    const dispatch = vi.fn().mockResolvedValue({ state: "active" });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;

    await coordinateWorkerPlacementDispatch(service).dispatch(REQUEST, observer, authorize);

    expect(dispatch).toHaveBeenCalledWith(REQUEST, observer, authorize);
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
    await expect(coordinated.dispatch({ ...REQUEST, machineClass: "beast" })).rejects.toThrow(
      `Session ${REQUEST.sessionKey} is already dispatching another request`,
    );
    await expect(
      coordinated.dispatch({
        ...REQUEST,
        inheritedProfile: {
          providerId: "fake",
          profileSnapshot: { settings: { region: "parent" } },
        },
      }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const modeConflict = expect(
      coordinated.dispatch({ ...REQUEST, executionMode: "remote-exec" }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const retry = coordinated.dispatch(REQUEST);
    releaseDispatch.resolve();

    await modeConflict;
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

  it("serializes a move against new dispatches", async () => {
    const moveStarted = createDeferredCore();
    const releaseMove = createDeferredCore();
    const dispatch = vi.fn().mockResolvedValue({ state: "active" });
    const move = vi.fn(async () => {
      moveStarted.resolve();
      await releaseMove.promise;
      return { state: "local" };
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      move,
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const moving = coordinated.move(MOVE_REQUEST);
    await moveStarted.promise;
    const retry = coordinated.move(MOVE_REQUEST);
    await expect(
      coordinated.move({ ...MOVE_REQUEST, target: { kind: "profile", profileId: "other" } }),
    ).rejects.toThrow(`Session ${MOVE_REQUEST.sessionKey} is already moving to another target`);
    const dispatching = coordinated.dispatch(REQUEST);
    expect(dispatch).not.toHaveBeenCalled();
    releaseMove.resolve();

    const [moveResult, retryResult] = await Promise.all([moving, retry]);
    expect(retryResult).toBe(moveResult);
    await dispatching;
    expect(move).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("serializes reclaim behind an in-flight dispatch", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return { state: "active" };
    });
    const reclaim = vi.fn().mockResolvedValue({ state: "reclaimed" });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim,
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const dispatching = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const reclaiming = coordinated.reclaim({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
    });

    expect(reclaim).not.toHaveBeenCalled();
    releaseDispatch.resolve();
    await dispatching;
    await reclaiming;
    expect(reclaim).toHaveBeenCalledOnce();
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

  it("fences external provisioning recovery behind fresh dispatch without self-deadlocking", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return { state: "active" };
    });
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      await reconcileCore();
    });
    const reconcile = vi.fn();
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);
    reconcile.mockImplementation(async () => {
      await coordinated.resumeProvisioning({} as never, async () => {});
    });

    const dispatching = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const recoveryCore = vi.fn(async () => {});
    const recovering = coordinated.resumeProvisioning({} as never, recoveryCore);
    await Promise.resolve();
    expect(resumeProvisioning).not.toHaveBeenCalled();
    releaseDispatch.resolve();
    await Promise.all([dispatching, recovering]);
    expect(resumeProvisioning).toHaveBeenCalledWith({}, recoveryCore);

    await coordinated.reconcile();
    expect(resumeProvisioning).toHaveBeenCalledTimes(2);
  });

  it("lets a full sweep own and join a preexisting environment recovery pass", async () => {
    const dispatchStarted = createDeferredCore();
    const releaseDispatch = createDeferredCore();
    const environmentPassStarted = createDeferredCore();
    const releaseEnvironmentGuard = createDeferredCore();
    const environmentGuardEntered = createDeferredCore();
    const fullSweepJoinedEnvironmentPass = createDeferredCore();
    const recoveryCore = vi.fn(async () => {});
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      await reconcileCore();
    });
    const dispatch = vi.fn(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      return { state: "active" };
    });
    let environmentPass: Promise<void> | undefined;
    const reconcileEnvironmentOnce = () =>
      (environmentPass ??= (async () => {
        environmentPassStarted.resolve();
        await releaseEnvironmentGuard.promise;
        environmentGuardEntered.resolve();
        await coordinated.resumeProvisioning({} as never, recoveryCore);
      })().finally(() => {
        environmentPass = undefined;
      }));
    const reconcile = vi.fn(async () => {
      fullSweepJoinedEnvironmentPass.resolve();
      await reconcileEnvironmentOnce();
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const dispatching = coordinated.dispatch(REQUEST);
    await dispatchStarted.promise;
    const externalEnvironmentPass = reconcileEnvironmentOnce();
    await environmentPassStarted.promise;
    const fullSweep = coordinated.reconcile();
    releaseEnvironmentGuard.resolve();
    await environmentGuardEntered.promise;
    await Promise.resolve();
    expect(resumeProvisioning).not.toHaveBeenCalled();
    releaseDispatch.resolve();
    await dispatching;
    await fullSweepJoinedEnvironmentPass.promise;
    await Promise.resolve();

    expect(resumeProvisioning).toHaveBeenCalledOnce();
    await Promise.all([externalEnvironmentPass, fullSweep]);
    expect(recoveryCore).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("lets environment recovery created by a full sweep join that sweep", async () => {
    const environmentPassStarted = createDeferredCore();
    const releaseEnvironmentGuard = createDeferredCore();
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      await reconcileCore();
    });
    const recoveryCore = vi.fn(async () => {});
    const reconcile = vi.fn(async () => {
      environmentPassStarted.resolve();
      await releaseEnvironmentGuard.promise;
      await coordinated.resumeProvisioning({} as never, recoveryCore);
    });
    const service = {
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const fullSweep = coordinated.reconcile();
    await environmentPassStarted.promise;
    releaseEnvironmentGuard.resolve();
    await fullSweep;

    expect(resumeProvisioning).toHaveBeenCalledOnce();
    expect(recoveryCore).toHaveBeenCalledOnce();
  });

  it("runs a full sweep requested behind external recovery", async () => {
    const recoveryStarted = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      recoveryStarted.resolve();
      await releaseRecovery.promise;
      await reconcileCore();
    });
    const reconcile = vi.fn(async () => {});
    const service = {
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const recovering = coordinated.resumeProvisioning({} as never, async () => {});
    await recoveryStarted.promise;
    const fullSweep = coordinated.reconcile();
    expect(reconcile).not.toHaveBeenCalled();
    releaseRecovery.resolve();
    await Promise.all([recovering, fullSweep]);

    expect(resumeProvisioning).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("finishes sweep-owned recovery before an exclusive barrier queued behind the sweep", async () => {
    const environmentPassStarted = createDeferredCore();
    const releaseEnvironmentGuard = createDeferredCore();
    const recoveryStarted = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const exclusiveStarted = createDeferredCore();
    const releaseExclusive = createDeferredCore();
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      recoveryStarted.resolve();
      await reconcileCore();
      await releaseRecovery.promise;
    });
    const forceDestroyEnvironment = vi.fn(async () => {
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
    });
    const reconcile = vi.fn(async () => {
      environmentPassStarted.resolve();
      await releaseEnvironmentGuard.promise;
      await coordinated.resumeProvisioning({} as never, async () => {});
    });
    const service = {
      dispatch: vi.fn(),
      forceDestroyEnvironment,
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const fullSweep = coordinated.reconcile();
    await environmentPassStarted.promise;
    const destroying = coordinated.forceDestroyEnvironment("worker-exclusive");
    releaseEnvironmentGuard.resolve();
    await recoveryStarted.promise;
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();
    releaseRecovery.resolve();
    await fullSweep;
    await exclusiveStarted.promise;
    releaseExclusive.resolve();
    await destroying;

    expect(resumeProvisioning).toHaveBeenCalledOnce();
    expect(forceDestroyEnvironment).toHaveBeenCalledOnce();
  });

  it.each(["fulfilled", "rejected"] as const)(
    "holds an exclusive fence until an independently joined late recovery settles (%s)",
    async (outcome) => {
      const sweepStarted = createDeferredCore();
      const releaseSweep = createDeferredCore();
      const recoveryStarted = createDeferredCore();
      const releaseRecovery = createDeferredCore();
      const recoveryError = new Error("joined recovery failed");
      const reconcile = vi.fn(async () => {
        sweepStarted.resolve();
        await releaseSweep.promise;
      });
      const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
        recoveryStarted.resolve();
        await reconcileCore();
        await releaseRecovery.promise;
      });
      const forceDestroyEnvironment = vi.fn(async () => {});
      const service = {
        dispatch: vi.fn(),
        forceDestroyEnvironment,
        reclaim: vi.fn(),
        reconcile,
        reconcileActive: vi.fn(),
        resumeProvisioning,
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service);

      const fullSweep = coordinated.reconcile();
      await sweepStarted.promise;
      const destroying = coordinated.forceDestroyEnvironment("worker-exclusive");
      const recoveryOutcome = coordinated
        .resumeProvisioning({} as never, async () => {})
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await recoveryStarted.promise;
      releaseSweep.resolve();
      await setImmediatePromise();

      expect(forceDestroyEnvironment).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        releaseRecovery.reject(recoveryError);
      } else {
        releaseRecovery.resolve();
      }
      await Promise.all([fullSweep, destroying]);

      expect(await recoveryOutcome).toBe(outcome === "rejected" ? recoveryError : undefined);
      expect(resumeProvisioning).toHaveBeenCalledOnce();
      expect(forceDestroyEnvironment).toHaveBeenCalledOnce();
    },
  );

  it("queues recovery arriving after sweep join admission closes behind the exclusive fence", async () => {
    const sweepStarted = createDeferredCore();
    const releaseSweep = createDeferredCore();
    const joinedRecoveryStarted = createDeferredCore();
    const releaseJoinedRecovery = createDeferredCore();
    const exclusiveStarted = createDeferredCore();
    const releaseExclusive = createDeferredCore();
    const reconcile = vi.fn(async () => {
      sweepStarted.resolve();
      await releaseSweep.promise;
    });
    const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
      await reconcileCore();
    });
    const forceDestroyEnvironment = vi.fn(async () => {
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
    });
    const service = {
      dispatch: vi.fn(),
      forceDestroyEnvironment,
      reclaim: vi.fn(),
      reconcile,
      reconcileActive: vi.fn(),
      resumeProvisioning,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service);

    const fullSweep = coordinated.reconcile();
    await sweepStarted.promise;
    const destroying = coordinated.forceDestroyEnvironment("worker-exclusive");
    const joinedRecovery = coordinated.resumeProvisioning({} as never, async () => {
      joinedRecoveryStarted.resolve();
      await releaseJoinedRecovery.promise;
    });
    await joinedRecoveryStarted.promise;
    releaseSweep.resolve();
    await setImmediatePromise();

    const lateRecovery = coordinated.resumeProvisioning({} as never, async () => {});
    await setImmediatePromise();
    expect(resumeProvisioning).toHaveBeenCalledOnce();
    expect(forceDestroyEnvironment).not.toHaveBeenCalled();

    releaseJoinedRecovery.resolve();
    await Promise.all([fullSweep, joinedRecovery, exclusiveStarted.promise]);
    expect(resumeProvisioning).toHaveBeenCalledOnce();
    releaseExclusive.resolve();
    await Promise.all([destroying, lateRecovery]);

    expect(resumeProvisioning).toHaveBeenCalledTimes(2);
    expect(forceDestroyEnvironment).toHaveBeenCalledOnce();
  });

  it.each(["move", "reclaim", "forceDestroyEnvironment"] as const)(
    "keeps recovery behind an active exclusive %s barrier",
    async (barrierKind) => {
      const barrierStarted = createDeferredCore();
      const releaseBarrier = createDeferredCore();
      const exclusiveOperation = vi.fn(async () => {
        barrierStarted.resolve();
        await releaseBarrier.promise;
        return {};
      });
      const resumeProvisioning = vi.fn(async (_placement, reconcileCore) => {
        await reconcileCore();
      });
      const service = {
        dispatch: vi.fn(),
        forceDestroyEnvironment: exclusiveOperation,
        move: exclusiveOperation,
        reclaim: exclusiveOperation,
        reconcile: vi.fn(),
        reconcileActive: vi.fn(),
        resumeProvisioning,
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service);
      const barrier =
        barrierKind === "move"
          ? coordinated.move(MOVE_REQUEST)
          : barrierKind === "reclaim"
            ? coordinated.reclaim({
                sessionId: REQUEST.sessionId,
                sessionKey: REQUEST.sessionKey,
                agentId: REQUEST.agentId,
              })
            : coordinated.forceDestroyEnvironment("worker-exclusive");
      await barrierStarted.promise;

      const recovering = coordinated.resumeProvisioning({} as never, async () => {});
      await Promise.resolve();
      expect(resumeProvisioning).not.toHaveBeenCalled();
      releaseBarrier.resolve();
      await Promise.all([barrier, recovering]);

      expect(exclusiveOperation).toHaveBeenCalledOnce();
      expect(resumeProvisioning).toHaveBeenCalledOnce();
    },
  );
});
