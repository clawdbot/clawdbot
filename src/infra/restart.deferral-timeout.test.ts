// Tests restart deferral timeout behavior and fallback cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  consumeGatewaySigusr1RestartIntent,
  deferGatewayRestartUntilIdle,
  resetGatewayRestartStateForInProcessRestart,
} from "./restart.js";

type RestartDeferralHooks = NonNullable<
  Parameters<typeof deferGatewayRestartUntilIdle>[0]["hooks"]
>;

const sigusr1Handler = () => {};

describe("deferGatewayRestartUntilIdle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    // A listener makes restart emission use process.emit instead of process.kill.
    process.on("SIGUSR1", sigusr1Handler);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    process.removeListener("SIGUSR1", sigusr1Handler);
  });

  it("waits indefinitely when maxWaitMs is not specified", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
      onStillPending: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks,
    });

    vi.advanceTimersByTime(300_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onStillPending).toHaveBeenCalled();

    vi.advanceTimersByTime(300_000);
    expect(hooks.onTimeout).not.toHaveBeenCalled();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("respects custom maxWaitMs configuration", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 120_000,
      hooks,
    });

    vi.advanceTimersByTime(119_999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });

  it("clamps oversized poll intervals instead of polling immediately", () => {
    const hooks: RestartDeferralHooks = { onReady: vi.fn() };
    let pending = 1;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      pollMs: Number.MAX_SAFE_INTEGER,
      hooks,
    });

    pending = 0;
    vi.advanceTimersByTime(1);
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("carries timeout restart intent when the deferral budget is exhausted", () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 1_000,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
    });

    vi.advanceTimersByTime(1_000);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(consumeGatewaySigusr1RestartIntent()).toEqual({
      force: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });

  it("calls onReady and does not timeout when pending count drops to 0", async () => {
    const hooks: RestartDeferralHooks = {
      onTimeout: vi.fn(),
      onReady: vi.fn(),
    };
    let pending = 3;

    deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      hooks,
    });

    vi.advanceTimersByTime(1_000);
    expect(hooks.onReady).not.toHaveBeenCalled();

    pending = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  it("cancels a pending deferral before it can emit", () => {
    let pending = 1;
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => pending,
      emitHooks: { emitRestart },
    });

    handle.cancel();
    pending = 0;
    vi.advanceTimersByTime(1_000);

    expect(emitRestart).not.toHaveBeenCalled();
  });

  it("forces a timed-out restart while an admitted root remains", async () => {
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 10,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(emitRestart).toHaveBeenCalledOnce();
    root?.release();
  });

  it("reopens admission when a blocked preparation is cancelled", async () => {
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handle = deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      emitHooks: {
        beforeEmit: async () => await preparation,
        emitRestart,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    handle.cancel();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    releasePreparation?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitRestart).not.toHaveBeenCalled();
  });

  it("reopens admission when a prepared restart is superseded", async () => {
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      emitHooks: { emitRestart: () => ({ status: "coalesced" }) },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("immediately restarts when pending count is 0", async () => {
    const hooks: RestartDeferralHooks = {
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      hooks,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.onReady).toHaveBeenCalledOnce();
    expect(hooks.onTimeout).not.toHaveBeenCalled();
  });

  // #104064: an inspection exception means active-work state is unknown;
  // fail closed by entering the deferred poll and retrying instead of
  // emitting a restart (the old fail-open behavior).
  it("defers restart when initial getPendingCount throws", () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
      onDeferring: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      hooks,
    });

    expect(hooks.onCheckError).toHaveBeenCalledOnce();
    // Must enter deferred state, not emit a restart
    expect(hooks.onDeferring).toHaveBeenCalled();
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("retries on the next poll after initial getPendingCount throws, then emits when zero", async () => {
    let callCount = 0;
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
      onDeferring: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient");
        }
        return 0;
      },
      hooks,
    });

    // Initial inspection threw: deferred, no restart
    expect(hooks.onCheckError).toHaveBeenCalledOnce();
    expect(hooks.onReady).not.toHaveBeenCalled();

    // Next poll succeeds with zero: emit restart
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onReady).toHaveBeenCalledOnce();
  });

  it("preserves active poll when polling getPendingCount throws", async () => {
    let callCount = 0;
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        callCount++;
        if (callCount <= 2) {
          return 1; // initial + first poll: pending
        }
        if (callCount === 3) {
          throw new Error("transient"); // second poll: throw
        }
        return 0; // third poll: drained
      },
      hooks,
    });

    // First poll: still pending
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onReady).not.toHaveBeenCalled();

    // Second poll: throws — poll must remain active
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onCheckError).toHaveBeenCalledOnce();
    expect(hooks.onReady).not.toHaveBeenCalled();

    // Third poll: zero — restart emitted
    await vi.advanceTimersByTimeAsync(500);
    expect(hooks.onReady).toHaveBeenCalledOnce();
  });

  it("fires force timeout when polling getPendingCount keeps throwing", async () => {
    const hooks: RestartDeferralHooks = {
      onCheckError: vi.fn(),
      onReady: vi.fn(),
      onTimeout: vi.fn(),
    };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("persistent");
      },
      maxWaitMs: 1_000,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
    });

    // Elapsed time has not yet reached the force timeout
    vi.advanceTimersByTime(999);
    expect(hooks.onTimeout).not.toHaveBeenCalled();

    // Force timeout fires even though every inspection throws
    vi.advanceTimersByTime(1);
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(consumeGatewaySigusr1RestartIntent()).toEqual({
      force: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });
});
