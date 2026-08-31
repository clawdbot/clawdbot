// Covers root work counting and reversible suspension admission transitions.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginGatewayRestartSignalAdmission,
  beginGatewayRootWorkAdmissionWhenOpen,
  captureGatewayRootWorkAdmissionContinuationScope,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDrainError,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  retainGatewayRootWorkAdmissionContinuation,
  resetGatewayWorkAdmission,
  rollbackGatewayRestartSignalFence,
  runWithGatewayIndependentRootWorkContinuation,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRestartStartupRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "./gateway-work-admission.test-helpers.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

it("classifies draining errors only while an authoritative restart signal or drain is active", () => {
  const error = new GatewayDrainingError();
  const firstDrainSignal = getGatewayRestartDrainSignal();

  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(isGatewayRestartDrainError(new Error("GatewayDrainingError"))).toBe(false);

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(isGatewayRestartDrainError(error)).toBe(false);
  expect(suspension?.rollback()).toBe(true);

  const signal = beginGatewayRestartSignalAdmission();
  expect(isGatewayRestartDrainError(error)).toBe(true);
  expect(isGatewayRestartDrainError(new Error("gateway is draining for restart"))).toBe(false);
  expect(signal?.rollback()).toBe(true);
  expect(isGatewayRestartDrainError(error)).toBe(false);

  markGatewayRestartDraining();
  expect(isGatewayRestartDrainError(error)).toBe(true);
  expect(firstDrainSignal.aborted).toBe(true);

  resetGatewayWorkAdmission();
  const nextDrainSignal = getGatewayRestartDrainSignal();
  expect(nextDrainSignal).not.toBe(firstDrainSignal);
  expect(nextDrainSignal.aborted).toBe(false);
  markGatewayRestartDraining();
  expect(nextDrainSignal.aborted).toBe(true);
});

it("counts one nested root chain once and excludes the preparing caller", async () => {
  const outer = tryBeginGatewayRootWorkAdmission();
  expect(outer).not.toBeNull();
  expect(outer?.ownsRoot).toBe(true);
  await outer?.run(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).not.toBeNull();
    expect(nested?.ownsRoot).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    nested?.release();
  });
  outer?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("rolls back or releases a generation-bound suspension without resetting roots", () => {
  const invalidated = vi.fn();
  const preparing = tryBeginGatewaySuspendAdmission(invalidated);
  expect(preparing).not.toBeNull();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(preparing?.rollback()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);

  const prepared = tryBeginGatewaySuspendAdmission(invalidated);
  expect(prepared?.commit()).toBe(true);
  expect(prepared?.release()).toBe(true);
  expect(prepared?.release()).toBe(false);
  expect(invalidated).not.toHaveBeenCalled();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("drains already-admitted work before promoting the same generation to prepared", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root?.ownsRoot).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(getGatewaySuspendAdmissionPhase()).toBe("preparing");
  expect(suspension?.drain()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  await root?.run(async () => {
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    const subordinate = tryBeginGatewayRootWorkAdmission();
    expect(subordinate?.ownsRoot).toBe(false);
    subordinate?.release();
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    });
  });
  root?.release();

  expect(suspension?.commit()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
  const targetedRestart = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(targetedRestart?.ownsRoot).toBe(true);
  targetedRestart?.release();
  expect(suspension?.release()).toBe(true);
  expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");
});

it("releases draining admission without allowing stale generations to reopen it", () => {
  const first = tryBeginGatewaySuspendAdmission(() => {});
  expect(first?.drain()).toBe(true);
  expect(first?.rollback()).toBe(false);
  expect(first?.release()).toBe(true);

  const second = tryBeginGatewaySuspendAdmission(() => {});
  expect(second?.drain()).toBe(true);
  expect(first?.drain()).toBe(false);
  expect(first?.commit()).toBe(false);
  expect(first?.release()).toBe(false);
  expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
  expect(second?.release()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});

it("admits a targeted restart root only from prepared suspension", () => {
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(suspension?.commit()).toBe(true);

  const restartRoot = tryBeginGatewayPreparedRestartRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  restartRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(suspension?.release()).toBe(true);

  const prepared = tryBeginGatewaySuspendAdmission(() => {});
  expect(prepared?.commit()).toBe(true);
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
  expect(pendingSignal?.rollback()).toBe(true);
  expect(prepared?.release()).toBe(true);

  markGatewayRestartDraining();
  expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();
});

it("admits a tracked restart-startup root only while restart fencing accepts recovery", async () => {
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();

  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  expect(suspension?.commit()).toBe(true);
  const suspendedSignal = beginGatewayRestartSignalAdmission();
  expect(suspendedSignal).not.toBeNull();
  expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  expect(suspendedSignal?.rollback()).toBe(true);
  expect(suspension?.release()).toBe(true);

  const signal = beginGatewayRestartSignalAdmission();
  const signalRoot = tryBeginGatewayRestartStartupRootWorkAdmission();
  expect(signalRoot?.ownsRoot).toBe(true);
  await signalRoot?.run(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(0);
  });
  signalRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(signal?.rollback()).toBe(true);

  markGatewayRestartDraining();
  const restartRoot = tryBeginGatewayRestartStartupRootWorkAdmission();
  expect(restartRoot?.ownsRoot).toBe(true);
  await restartRoot?.run(async () => {
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    resetGatewayWorkAdmission();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    expect(tryBeginGatewayRestartStartupRootWorkAdmission()).toBeNull();
  });
  restartRoot?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("lets an admitted root cross only the reversible suspension fence", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    expect(suspension?.rollback()).toBe(true);

    markGatewayRestartDraining();
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  });
  root?.release();
});

it("synchronously reserves a tracked continuation across a closed suspension fence", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  let releaseContinuation = () => {};
  let continuation: Promise<void> | undefined;
  await root?.run(async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    continuation = runWithGatewayIndependentRootWorkContinuation(
      async () =>
        await new Promise<void>((resolve) => {
          releaseContinuation = resolve;
        }),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    expect(suspension?.rollback()).toBe(true);
  });

  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  releaseContinuation();
  await continuation;
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("retains an admitted request root across its handler return", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  let continueChild = () => {};
  let releaseContinuation = () => {};
  let subordinateAdmissionClosed: boolean | undefined;
  let child: Promise<void> | undefined;
  const childGate = new Promise<void>((resolve) => {
    continueChild = resolve;
  });

  await root?.run(async () => {
    const retainedRelease = retainGatewayRootWorkAdmissionContinuation();
    expect(retainedRelease).not.toBeNull();
    releaseContinuation = retainedRelease ?? (() => {});
    child = (async () => {
      await childGate;
      subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
    })();
  });

  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(1);
  continueChild();
  await child;
  expect(subordinateAdmissionClosed).toBe(false);
  releaseContinuation();
  releaseContinuation();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("does not extend the creating root's lifetime when a continuation only borrows ownership", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  const borrowed = await root?.run(async () => captureGatewayRootWorkAdmissionContinuationScope());

  expect(getActiveGatewayRootWorkCount()).toBe(1);
  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  await expect(borrowed?.run(async () => {})).rejects.toThrow(
    "gateway root work continuation is no longer active",
  );
  borrowed?.release();
});

it("keeps borrowed-root completion alive when its owner and original request settle", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  const borrowed = await root?.run(async () => captureGatewayRootWorkAdmissionContinuationScope());
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.drain()).toBe(true);

  await borrowed?.run(async () => {
    borrowed.release();
    root?.release();
    await Promise.resolve();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
  });

  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(suspension?.release()).toBe(true);
});

it("does not retire process-lifetime work with the request that started it", async () => {
  let releaseChild = () => {};
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let child: Promise<boolean> | undefined;

  await runWithGatewayRootWorkAdmissionForTest(async () => {
    child = runOutsideGatewayRootWorkAdmission(async () => {
      await childGate;
      return isGatewaySubordinateWorkAdmissionClosed();
    });
  });

  releaseChild();
  await expect(child).resolves.toBe(false);
});

it("runs an admitted continuation when restart drain wins the handoff race", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  const ran = vi.fn();
  await root?.run(async () => {
    markGatewayRestartDraining();
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      ran();
    });
  });
  root?.release();

  expect(ran).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("does not admit an unrelated continuation through restart drain", async () => {
  markGatewayRestartDraining();
  const ran = vi.fn();

  await expect(
    runWithGatewayIndependentRootWorkContinuation(async () => {
      ran();
    }),
  ).rejects.toThrow("gateway is draining for restart");
  expect(ran).not.toHaveBeenCalled();
});

it("real restart drain blocks a reserved continuation before provider execution and releases it", async () => {
  let releaseContinuation = () => {};
  const continuationGate = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  const providerStarted = vi.fn();
  let continuation: Promise<void> | undefined;

  await runWithGatewayRootWorkAdmissionForTest(async () => {
    continuation = runWithGatewayIndependentRootWorkContinuation(async () => {
      await continuationGate;
      if (isGatewaySubordinateWorkAdmissionClosed()) {
        throw new GatewayDrainingError();
      }
      providerStarted();
    });
  });

  expect(getActiveGatewayRootWorkCount()).toBe(1);
  markGatewayRestartDraining();
  releaseContinuation();
  await expect(continuation).rejects.toThrow(GatewayDrainingError);
  expect(providerStarted).not.toHaveBeenCalled();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("does not let a stale suspension release clear restart drain", () => {
  const invalidated = vi.fn();
  const suspension = tryBeginGatewaySuspendAdmission(invalidated);
  expect(suspension?.commit()).toBe(true);

  markGatewayRestartDraining();

  expect(invalidated).toHaveBeenCalledOnce();
  expect(suspension?.release()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});

it("blocks suspension while restart signal handling is pending", () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();

  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(tryBeginGatewaySuspendAdmission(() => {})).toBeNull();
  expect(beginGatewayRestartSignalAdmission()).toBeNull();
  expect(pendingSignal?.rollback()).toBe(true);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  expect(tryBeginGatewaySuspendAdmission(() => {})?.rollback()).toBe(true);
});

it("promotes a pending restart signal to one-way drain", () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();

  markGatewayRestartDraining();

  expect(pendingSignal?.rollback()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
});

it("force-rolls back an orphan restart-signal fence without a live lease", () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);

  // Drop the lease the way a concurrent emission overwrite used to: the fence
  // stays closed with no handle that can reopen it.
  expect(rollbackGatewayRestartSignalFence()).toBe(true);
  expect(pendingSignal?.rollback()).toBe(false);
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  root?.release();
});

it("wakes beginGatewayRootWorkAdmissionWhenOpen waiters when the signal fence rolls back", async () => {
  const pendingSignal = beginGatewayRestartSignalAdmission();
  expect(pendingSignal).not.toBeNull();

  const waiting = beginGatewayRootWorkAdmissionWhenOpen();
  let resolved = false;
  void waiting.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);

  expect(pendingSignal?.rollback()).toBe(true);
  const admission = await waiting;
  expect(resolved).toBe(true);
  expect(admission.ownsRoot).toBe(true);
  admission.release();
});

it("defers required internal root work until suspension reopens", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const entered = vi.fn();
  const pending = runWithGatewayRootWorkAdmissionForTest(async () => {
    entered();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  });

  await Promise.resolve();
  expect(entered).not.toHaveBeenCalled();
  suspension?.release();
  await pending;

  expect(entered).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("retires surviving root records across an in-process reset", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  await root?.run(async () => {
    resetGatewayWorkAdmission();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
    const nested = tryBeginGatewayRootWorkAdmission();
    expect(nested).not.toBeNull();
    expect(nested?.ownsRoot).toBe(true);
    await nested?.run(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
    });
    nested?.release();
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
  });
  root?.release();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("does not wake deferred internal work into a restart drain", async () => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const pending = runWithGatewayRootWorkAdmissionForTest(async () => {});

  markGatewayRestartDraining();

  await expect(pending).rejects.toBeInstanceOf(GatewayDrainingError);
});
