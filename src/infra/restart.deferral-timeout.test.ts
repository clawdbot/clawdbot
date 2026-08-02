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

  // A failed inspection leaves active work UNKNOWN, not absent. These three cases pin the
  // boundary: never restart on the failure itself, keep retrying, and still escalate through
  // the bounded deferral budget so a permanently broken probe cannot hang restarts forever.
  it("defers instead of restarting when the initial pending inspection throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR1", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          call += 1;
          if (call === 1) {
            throw new Error("store corrupted");
          }
          return 0;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.onCheckError).toHaveBeenCalledOnce();
      expect(emissions).toBe(0);
      expect(hooks.onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
      expect(hooks.onReady).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("SIGUSR1", countEmission);
    }
  });

  it("keeps the deferral polling when a later pending inspection throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR1", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      const counts: Array<number | "throw"> = [1, "throw", 0];
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          const next = counts[Math.min(call, counts.length - 1)];
          call += 1;
          if (next === "throw") {
            throw new Error("store corrupted");
          }
          return next as number;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(hooks.onCheckError).toHaveBeenCalledOnce();
      expect(emissions).toBe(0);

      // The poll must have survived the exception for this zero to be observed at all.
      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
      expect(hooks.onReady).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("SIGUSR1", countEmission);
    }
  });

  it("does not emit when the final admission-time pending read throws", async () => {
    let emissions = 0;
    const countEmission = () => {
      emissions += 1;
    };
    process.on("SIGUSR1", countEmission);
    try {
      const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
      // initial throw -> poll reads 0 -> the final admission read throws -> later reads are 0.
      const counts: Array<number | "throw"> = ["throw", 0, "throw"];
      let call = 0;

      deferGatewayRestartUntilIdle({
        getPendingCount: () => {
          const next = call < counts.length ? counts[call] : 0;
          call += 1;
          if (next === "throw") {
            throw new Error("store corrupted");
          }
          return next as number;
        },
        pollMs: 10,
        hooks,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(0);

      // Recovery still has to go through a clean admission read before emitting.
      await vi.advanceTimersByTimeAsync(10);
      expect(emissions).toBe(1);
    } finally {
      process.removeListener("SIGUSR1", countEmission);
    }
  });

  // A rejected emission is not evidence of idleness either. The old path stopped the
  // poll and re-emitted with no idle check, so the deferral died after one blind retry.
  it("keeps deferring when the emission itself rejects", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onReady: vi.fn() };
    let emitAttempts = 0;

    deferGatewayRestartUntilIdle({
      // Idle from the start, so every poll reaches emission; emission is what fails.
      getPendingCount: () => 0,
      pollMs: 10,
      hooks,
      emitHooks: {
        emitRestart: () => {
          emitAttempts += 1;
          throw new Error("independent-root admission rejected");
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = emitAttempts;
    expect(afterFirst).toBeGreaterThan(0);
    expect(hooks.onCheckError).toHaveBeenCalled();

    // The poll must still be live, so later intervals keep retrying the emission
    // rather than the deferral going silent after one unchecked re-emit.
    await vi.advanceTimersByTimeAsync(50);
    expect(emitAttempts).toBeGreaterThan(afterFirst);
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it("still escalates through the deferral budget when inspection never recovers", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onTimeout: vi.fn() };

    deferGatewayRestartUntilIdle({
      getPendingCount: () => {
        throw new Error("store corrupted");
      },
      pollMs: 10,
      maxWaitMs: 100,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(consumeGatewaySigusr1RestartIntent()).toEqual({
      force: true,
      reason: "gateway.restart.deferral-timeout",
    });
  });
});
