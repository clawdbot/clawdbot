import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  beginSessionWorkAdmission,
  closeSessionWorkAdmissions,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  admittedRecovery,
  MOVE_REQUEST,
  preparedReclaim,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

describe("worker placement dispatch coordinator", () => {
  it.each([
    { kind: "dispatch", blocker: "sweep" },
    { kind: "move", blocker: "sweep" },
    { kind: "move", blocker: "dispatch" },
  ] as const)(
    "cancels queued $kind without releasing the unrelated $blocker fence",
    async ({ kind, blocker }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const admitted = createDeferredCore();
      const controller = new AbortController();
      const block = async () => {
        entered.resolve();
        await release.promise;
      };
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === "blocker") {
          await block();
        }
        return { state: "active" };
      });
      const move = vi.fn(async () => ({ state: "local" }));
      const coordinated = coordinateWorkerPlacementDispatch(
        { dispatch, move, reconcile: block } as unknown as DispatchService,
        async (request, run) => {
          if (request.sessionId !== REQUEST.sessionId) {
            return await run();
          }
          admitted.resolve();
          return await run(controller.signal);
        },
      );
      const blocking =
        blocker === "sweep"
          ? coordinated.reconcile()
          : coordinated.dispatch({ ...REQUEST, sessionId: "blocker" });
      await entered.promise;
      let outcome: unknown;
      const queued = (
        kind === "dispatch" ? coordinated.dispatch(REQUEST) : coordinated.move(MOVE_REQUEST)
      ).then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await admitted.promise;
      await setImmediatePromise();
      controller.abort(new DOMException("Stop queued work", "AbortError"));
      const later = coordinated.dispatch({ ...REQUEST, sessionId: "later" });
      try {
        await setImmediatePromise();
        expect(outcome).toMatchObject({ name: "AbortError" });
        expect(move).not.toHaveBeenCalled();
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(
          blocker === "dispatch" ? ["blocker"] : [],
        );
      } finally {
        release.resolve();
        await Promise.all([blocking, queued, later]);
      }
      expect(move).not.toHaveBeenCalled();
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(
        blocker === "dispatch" ? ["blocker", "later"] : ["later"],
      );
    },
  );

  it("retains both a dispatch and a queued Move until their exact operations settle", async () => {
    const dispatchEntered = createDeferredCore();
    const dispatchRelease = createDeferredCore();
    const moveAdmission = createDeferredCore();
    let admissions = 0;
    let stopped = false;
    const service = {
      dispatch: async () => {
        dispatchEntered.resolve();
        await dispatchRelease.promise;
        return { state: "active" };
      },
      move: async () => ({ state: "local" }),
      reclaim: async (
        ...[_request, _authorize, _beforeDrain, serialize, pending]: Parameters<
          DispatchService["reclaim"]
        >
      ) => {
        expect(pending?.isCurrent()).toBe(true);
        await pending!.settled;
        return await serialize!(async () => ({ state: "reclaimed" }) as never);
      },
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
      if (++admissions === 2) {
        await moveAdmission.promise;
      }
      return await run();
    });
    const dispatch = coordinated.dispatch(REQUEST);
    await dispatchEntered.promise;
    const moving = coordinated.move(MOVE_REQUEST);
    const stop = coordinated.reclaim(REQUEST).then(() => {
      stopped = true;
    });
    dispatchRelease.resolve();
    try {
      await dispatch;
      await setImmediatePromise();
      expect(stopped).toBe(false);
    } finally {
      moveAdmission.resolve();
      await Promise.all([moving, stop]);
    }
    expect(stopped).toBe(true);
  });

  it("admits a genuinely later dispatch only after the earlier Stop releases its admission closure", async () => {
    const stopping = createDeferredCore();
    const finishStop = createDeferredCore();
    const scope = "/tmp/openclaw-coordinator-predecessor-admission.sqlite";
    const identities = [REQUEST.sessionKey, REQUEST.sessionId];
    const dispatch = vi.fn(async () => ({ state: "active" }));
    const service = {
      dispatch,
      reclaim: async (
        ...[_request, _authorize, _beforeDrain, serialize]: Parameters<DispatchService["reclaim"]>
      ) => {
        const release = closeSessionWorkAdmissions({
          scope,
          identities,
          reason: new Error("older Stop"),
        });
        try {
          stopping.resolve();
          await finishStop.promise;
          return await serialize!(async () => ({ state: "reclaimed" }) as never);
        } finally {
          release();
        }
      },
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
      const controller = new AbortController();
      const admission = await beginSessionWorkAdmission({
        scope,
        identities,
        assertAllowed: () => {},
        onInterrupt: (reason) => controller.abort(reason),
      });
      try {
        return await admission.run(() => run(controller.signal));
      } finally {
        admission.release();
      }
    });
    const previous = coordinated.reclaim(REQUEST);
    await stopping.promise;
    const later = coordinated.dispatch(REQUEST);
    try {
      await setImmediatePromise();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      finishStop.resolve();
      await previous;
    }
    await expect(later).resolves.toMatchObject({ state: "active" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(["dispatch", "move"] as const)(
    "does not make a later Stop a predecessor of an admission-delayed %s",
    async (kind) => {
      const admitted = createDeferredCore();
      const controller = new AbortController();
      const dispatch = vi.fn(async () => ({ state: "active" }));
      const move = vi.fn(async () => ({ state: "local" }));
      const service = {
        dispatch,
        move,
        reclaim: async (
          ...[_request, _authorize, _beforeDrain, serialize, pending]: Parameters<
            DispatchService["reclaim"]
          >
        ) => {
          expect(pending?.isCurrent()).toBe(true);
          controller.abort(new Error("Stop"));
          await pending!.settled.catch(() => undefined);
          return await serialize!(async () => ({ state: "reclaimed" }) as never);
        },
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
        await admitted.promise;
        return await run(controller.signal);
      });
      let operationFinished = false;
      let stopFinished = false;
      const operation =
        kind === "dispatch" ? coordinated.dispatch(REQUEST) : coordinated.move(MOVE_REQUEST);
      void operation.then(
        () => {
          operationFinished = true;
        },
        () => {
          operationFinished = true;
        },
      );
      const stopping = coordinated.reclaim(REQUEST);
      void stopping.then(() => {
        stopFinished = true;
      });
      admitted.resolve();
      for (let turn = 0; turn < 10; turn++) {
        await setImmediatePromise();
      }
      expect(operationFinished).toBe(true);
      expect(stopFinished).toBe(true);
      await stopping;
      expect(dispatch).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    },
  );

  it.each(["dispatch", "move"] as const)(
    "later %s waits for every same-session Stop while cancellation recovery can run",
    async (kind) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const events: string[] = [];
      let stops = 0;
      const service = {
        dispatch: vi.fn(async (request: WorkerPlacementDispatchRequest) => {
          events.push(`dispatch:${request.sessionId}`);
          return { state: "active" };
        }),
        move: vi.fn(async () => {
          events.push("move");
          return { state: "local" };
        }),
        reclaim: async (
          ...[_request, _authorize, _beforeDrain, serialize]: Parameters<DispatchService["reclaim"]>
        ) => {
          if (++stops > 1) {
            throw new Error("second Stop failed");
          }
          entered.resolve();
          await release.promise;
          await coordinated.reconcileActive();
          return await serialize!(async () => {
            events.push("stop");
            return { state: "reclaimed" } as never;
          });
        },
        reconcileActive: vi.fn(async () => {
          events.push("recovery");
        }),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const stopping = coordinated.reclaim(REQUEST);
      await entered.promise;
      await expect(coordinated.reclaim(REQUEST)).rejects.toThrow("second Stop failed");
      const later =
        kind === "move" ? coordinated.move(MOVE_REQUEST) : coordinated.dispatch(REQUEST);
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      await setImmediatePromise();
      const beforeRelease = [...events];
      release.resolve();
      await Promise.all([stopping, later]);
      expect(beforeRelease).toEqual(["dispatch:unrelated"]);
      expect(events).toEqual([
        "dispatch:unrelated",
        "recovery",
        "stop",
        kind === "move" ? "move" : `dispatch:${REQUEST.sessionId}`,
      ]);
      expect(coordinated.isPlacementOperationInFlight(REQUEST.sessionId)).toBe(false);
    },
  );

  it("forwards in-process transition and authorization hooks outside request equality", async () => {
    const observer = vi.fn();
    const authorize = vi.fn();
    const placement = { state: "active" };
    const dispatch = vi.fn(async (_request, report, assertCurrent) => {
      assertCurrent?.();
      report?.(placement);
      return placement;
    });
    const service = {
      dispatch,
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;

    await coordinateWorkerPlacementDispatch(service, (_request, run) => run()).dispatch(
      REQUEST,
      observer,
      authorize,
    );

    expect(dispatch).toHaveBeenCalledWith(REQUEST, expect.any(Function), authorize, undefined);
    expect(authorize).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledExactlyOnceWith(placement);
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
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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
    const devicePlacementConflict = expect(
      coordinated.dispatch({
        ...REQUEST,
        devicePlacement: { requiredNodeCommands: ["system.run"], consumesWorkerSlot: true },
      }),
    ).rejects.toThrow(`Session ${REQUEST.sessionKey} is already dispatching another request`);
    const retry = coordinated.dispatch(REQUEST);
    releaseDispatch.resolve();

    await Promise.all([modeConflict, devicePlacementConflict]);
    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(retryResult).toBe(firstResult);
    expect(dispatch).toHaveBeenCalledOnce();

    await coordinated.dispatch({ ...REQUEST, profileId: "another-profile" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "dispatch", revokedBeforeJoining: true },
    { kind: "dispatch", revokedBeforeJoining: false },
    { kind: "move", revokedBeforeJoining: true },
    { kind: "move", revokedBeforeJoining: false },
  ] as const)(
    "rejects a joined $kind when its authority is revoked (before joining: $revokedBeforeJoining)",
    async ({ kind, revokedBeforeJoining }) => {
      const ownerStarted = createDeferredCore();
      const releaseOwner = createDeferredCore();
      const expectedResult = { state: kind === "dispatch" ? "active" : "local" };
      const operation = vi.fn(async () => {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return expectedResult;
      });
      const service = {
        dispatch: kind === "dispatch" ? operation : vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        move: kind === "move" ? operation : vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn(),
        reconcileActive: vi.fn(),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const invoke = (authorize?: () => void) =>
        kind === "dispatch"
          ? coordinated.dispatch(REQUEST, undefined, authorize)
          : coordinated.move(MOVE_REQUEST, undefined, authorize);
      const owner = invoke();
      await ownerStarted.promise;

      let revoked = revokedBeforeJoining;
      const observedAuthorizationStates: boolean[] = [];
      const authorize = () => {
        observedAuthorizationStates.push(revoked);
        if (revoked) {
          throw new Error("session access revoked");
        }
      };
      const joined = invoke(authorize);
      revoked = true;
      const outcomes = Promise.allSettled([owner, joined]);
      releaseOwner.resolve();

      await expect(outcomes).resolves.toEqual([
        { status: "fulfilled", value: expectedResult },
        { status: "rejected", reason: new Error("session access revoked") },
      ]);
      expect(observedAuthorizationStates).toEqual(revokedBeforeJoining ? [true] : [false, true]);
      expect(operation).toHaveBeenCalledOnce();
    },
  );

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
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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
      reclaim: preparedReclaim(reclaim),
      reconcile: vi.fn(),
      reconcileActive: vi.fn(),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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

  it.each(["full", "targeted"] as const)(
    "coalesces full sweeps and preserves fresh targets behind a %s sweep",
    async (firstKind) => {
      const fullSweepStarted = createDeferredCore();
      const releaseFullSweep = createDeferredCore();
      let first = true;
      const reconcileActive = vi.fn(async () => {
        if (first) {
          first = false;
          fullSweepStarted.resolve();
          await releaseFullSweep.promise;
        } else {
          await coordinated.resumeProvisioning({} as never, async () => {});
        }
      });
      const service = {
        dispatch: vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn(),
        reconcileActive,
        resumeProvisioning: admittedRecovery(vi.fn(async (_placement, core) => await core())),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

      const firstFullSweep =
        firstKind === "full"
          ? coordinated.reconcileActive()
          : coordinated.reconcileActive("worker-first");
      const secondFullSweep = coordinated.reconcileActive();
      const coalescedFullSweep = coordinated.reconcileActive();
      await fullSweepStarted.promise;
      const targetedSweep = coordinated.reconcileActive("worker-target");
      const secondTargetedSweep = coordinated.reconcileActive("worker-other");

      expect(reconcileActive).toHaveBeenCalledTimes(1);
      releaseFullSweep.resolve();
      await Promise.all([
        firstFullSweep,
        secondFullSweep,
        coalescedFullSweep,
        targetedSweep,
        secondTargetedSweep,
      ]);

      expect(reconcileActive.mock.calls).toEqual(
        firstKind === "full"
          ? [[], ["worker-target"], ["worker-other"]]
          : [["worker-first"], [], ["worker-target"], ["worker-other"]],
      );
    },
  );

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
      resumeProvisioning: admittedRecovery(resumeProvisioning),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
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
    expect(resumeProvisioning).toHaveBeenCalledWith({}, expect.any(Function));

    await coordinated.reconcile();
    expect(resumeProvisioning).toHaveBeenCalledTimes(2);
  });

  it.each(["full", "targeted"] as const)(
    "lets a %s sweep own and join a preexisting environment recovery pass",
    async (kind) => {
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
        reconcileActive: reconcile,
        resumeProvisioning: admittedRecovery(resumeProvisioning),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

      const dispatching = coordinated.dispatch(REQUEST);
      await dispatchStarted.promise;
      const externalEnvironmentPass = reconcileEnvironmentOnce();
      await environmentPassStarted.promise;
      const fullSweep =
        kind === "full" ? coordinated.reconcile() : coordinated.reconcileActive("worker-target");
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
    },
  );

  it.each(["full", "targeted"] as const)(
    "lets environment recovery created by a %s sweep join that sweep",
    async (kind) => {
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
        reconcileActive: reconcile,
        resumeProvisioning: admittedRecovery(resumeProvisioning),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

      const fullSweep =
        kind === "full" ? coordinated.reconcile() : coordinated.reconcileActive("worker-target");
      await environmentPassStarted.promise;
      releaseEnvironmentGuard.resolve();
      await fullSweep;

      expect(resumeProvisioning).toHaveBeenCalledOnce();
      expect(recoveryCore).toHaveBeenCalledOnce();
    },
  );

  it("publishes a recovery failure while retaining its unresolved provider owner", async () => {
    const providerEntered = createDeferredCore();
    const providerSettled = createDeferredCore();
    const admissionReleased = createDeferredCore();
    const failure = new Error("recovery cleanup failed after caller completion");
    const released = vi.fn();
    const reconcile = vi.fn(async () => {});
    const service = {
      resumeProvisioning: admittedRecovery(async (_placement, core) => await core()),
      reconcile,
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, async (_request, run) => {
      try {
        return await run();
      } finally {
        released();
        admissionReleased.resolve();
      }
    });
    let outcome: unknown;
    const recovery = coordinated
      .resumeProvisioning(REQUEST as never, async (_signal, retain) => {
        retain?.(providerSettled.promise);
        providerEntered.resolve();
        throw failure;
      })
      .catch((error: unknown) => {
        outcome = error;
      });
    try {
      await providerEntered.promise;
      await vi.waitFor(() => expect(outcome).toBe(failure));
      expect(released).not.toHaveBeenCalled();
      expect(coordinated.isPlacementOperationInFlight(REQUEST.sessionId)).toBe(true);
      await coordinated.reconcile();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(released).not.toHaveBeenCalled();
    } finally {
      providerSettled.resolve();
      await Promise.all([recovery, admissionReleased.promise]);
    }
    expect(released).toHaveBeenCalledOnce();
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
      resumeProvisioning: admittedRecovery(resumeProvisioning),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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
      resumeProvisioning: admittedRecovery(resumeProvisioning),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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

  it.each([
    { kind: "full", outcome: "fulfilled" },
    { kind: "full", outcome: "rejected" },
    { kind: "targeted", outcome: "fulfilled" },
    { kind: "targeted", outcome: "rejected" },
  ] as const)(
    "holds an exclusive fence until a $kind sweep late recovery settles ($outcome)",
    async ({ kind, outcome }) => {
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
        reconcileActive: reconcile,
        resumeProvisioning: admittedRecovery(resumeProvisioning),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

      const fullSweep =
        kind === "full" ? coordinated.reconcile() : coordinated.reconcileActive("worker-target");
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
      resumeProvisioning: admittedRecovery(resumeProvisioning),
    } as unknown as DispatchService;
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());

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
        reclaim: preparedReclaim(exclusiveOperation),
        reconcile: vi.fn(),
        reconcileActive: vi.fn(),
        resumeProvisioning: admittedRecovery(resumeProvisioning),
      } as unknown as DispatchService;
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
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
