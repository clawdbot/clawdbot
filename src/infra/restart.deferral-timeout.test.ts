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

  // A beforeEmit hook still pending at maxWaitMs left attemptingEmission set forever, so
  // the timeout branch's own forced attemptEmission call was a silent no-op (guarded by
  // that still-true flag) and the bounded restart deadline was defeated indefinitely.
  it("supersedes a stuck preparation at the deadline with a fresh one, not a bypassed one", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    // First call never settles (the stuck preparation); a fresh attempt started after
    // superseding it succeeds. beforeEmit must still run for the forced attempt — the
    // fix must not treat a caller's safety preflight as having already completed.
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      return beforeEmitCalls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    });

    deferGatewayRestartUntilIdle({
      // Idle from the start so the idle-triggered attempt fires at construction and its
      // beforeEmit starts preparing (and hangs) well before the deadline below.
      getPendingCount: () => 0,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { beforeEmit, emitRestart },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    // The forced retry must call beforeEmit again (fresh preparation), not skip it.
    expect(beforeEmitCalls).toBeGreaterThan(1);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  // ClawSweeper #118053: the takeover above used to be gated on the once-only onTimeout
  // notification, so it superseded the stuck idle attempt exactly once. If the FORCED
  // attempt it started then hung too, no later tick could replace it and the deferral
  // wedged permanently — the same defect, moved one attempt along.
  it("supersedes a forced preparation that also hangs after the deadline", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    // Both the idle-triggered attempt AND the first forced attempt hang; only the third
    // preparation settles. A once-only takeover never reaches it.
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      return beforeEmitCalls <= 2 ? new Promise<void>(() => {}) : Promise.resolve();
    });

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { beforeEmit, emitRestart },
    });

    // Each takeover waits a full preparation budget (maxWaitMs here), so the second
    // supersession lands at ~200ms.
    await vi.advanceTimersByTimeAsync(250);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    // Three real preparations: idle (hung), first forced (hung), second forced (settles).
    // Each runs its own beforeEmit, so no caller preflight is skipped by the takeover.
    expect(beforeEmitCalls).toBeGreaterThanOrEqual(3);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  // codex review: an earlier draft bounded the takeover to one POLL INTERVAL, which is a
  // cadence, not a preparation deadline — a beforeEmit that legitimately runs longer than
  // one interval (a config reload awaiting prepareRuntimeConfig exceeds the 500ms
  // production poll easily) would be superseded on every tick, thrashing fresh
  // preparations forever and never emitting. That traded a wedge for a livelock. The
  // budget is the deferral's own, so a slow preparation spanning many polls still lands.
  it("does not supersede a slow forced preparation that spans several poll intervals", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    let beforeEmitCalls = 0;
    let releaseForced: (() => void) | undefined;
    const beforeEmit = vi.fn(() => {
      beforeEmitCalls += 1;
      // Idle attempt hangs forever; the forced attempt settles only when released below.
      return beforeEmitCalls === 1
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => {
            releaseForced = resolve;
          });
    });

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 0,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { beforeEmit, emitRestart },
    });

    // Deadline tick supersedes the hung idle attempt and starts the forced one.
    await vi.advanceTimersByTimeAsync(100);
    expect(beforeEmitCalls).toBe(2);

    // Five further poll intervals elapse while the forced preparation is still running.
    // Under the rejected poll-interval bound this would have restarted it five times;
    // within its real budget it must be left completely alone.
    await vi.advanceTimersByTimeAsync(50);
    expect(beforeEmitCalls).toBe(2);

    releaseForced?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(emitRestart).toHaveBeenCalledOnce();
  });

  // If the forced attempt's own emission rejects, the deferral must not go silent forever:
  // the old path stopped the poll before the forced attempt ran, so nothing retried it.
  it("keeps retrying the forced restart when its emission rejects after the deadline", async () => {
    const hooks: RestartDeferralHooks = { onTimeout: vi.fn() };
    let emitAttempts = 0;
    const emitRestart = vi.fn(() => {
      emitAttempts += 1;
      if (emitAttempts < 3) {
        throw new Error("independent-root admission rejected");
      }
      return { status: "emitted" as const };
    });

    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 100,
      pollMs: 10,
      hooks,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });

    await vi.advanceTimersByTimeAsync(150);

    expect(hooks.onTimeout).toHaveBeenCalledOnce();
    expect(emitAttempts).toBeGreaterThanOrEqual(3);
  });

  // The idle branch (current <= 0) used to return before the maxWaitMs check below it.
  // A probe that keeps reporting idle while emission keeps failing hit that early return
  // on every single tick, so the bounded budget below it was never reached and the
  // deferral polled "idle" forever instead of escalating.
  it("still escalates through maxWaitMs when idle emission keeps failing", async () => {
    const hooks: RestartDeferralHooks = { onCheckError: vi.fn(), onTimeout: vi.fn() };
    let emitAttempts = 0;

    deferGatewayRestartUntilIdle({
      // Idle from the start so every poll takes the idle branch, never the unknown-count one.
      getPendingCount: () => 0,
      pollMs: 10,
      maxWaitMs: 100,
      hooks,
      timeoutIntent: { force: true, reason: "gateway.restart.deferral-timeout" },
      emitHooks: {
        emitRestart: () => {
          emitAttempts += 1;
          throw new Error("independent-root admission rejected");
        },
      },
    });

    await vi.advanceTimersByTimeAsync(100);

    // Repeated idle retries happened (the single-failed-probe-is-idle policy still holds)...
    expect(emitAttempts).toBeGreaterThan(1);
    // ...but the bounded budget still fired instead of looping the idle retry forever.
    expect(hooks.onTimeout).toHaveBeenCalledOnce();
  });
});
