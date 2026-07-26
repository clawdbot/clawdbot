// Covers root work counting and reversible suspension admission transitions.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginGatewayRestartSignalAdmission,
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  retainGatewayRootWorkAdmissionContinuation,
  resetGatewayWorkAdmission,
  rollbackGatewayRestartSignalFence,
  runWithGatewayIndependentRootWorkContinuation,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  waitForActiveGatewayRootWork,
} from "./gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "./gateway-work-admission.test-helpers.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

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

it("waits for admitted roots and reports a bounded timeout", async () => {
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  const pending = waitForActiveGatewayRootWork();
  await expect(waitForActiveGatewayRootWork(0)).resolves.toEqual({ drained: false, active: 1 });

  root?.release();

  await expect(pending).resolves.toEqual({ drained: true, active: 0 });
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
