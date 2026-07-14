import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
// Tests infra runtime loading and platform-dependent helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
type RestartModule = typeof import("./restart.js");

let consumeGatewaySigusr1RestartIntent: RestartModule["consumeGatewaySigusr1RestartIntent"];
let consumeGatewaySigusr1RestartAuthorization: RestartModule["consumeGatewaySigusr1RestartAuthorization"];
let deferGatewayRestartUntilIdle: RestartModule["deferGatewayRestartUntilIdle"];
let isGatewaySigusr1RestartExternallyAllowed: RestartModule["isGatewaySigusr1RestartExternallyAllowed"];
let markGatewaySigusr1RestartHandled: RestartModule["markGatewaySigusr1RestartHandled"];
let peekGatewaySigusr1RestartReason: RestartModule["peekGatewaySigusr1RestartReason"];
let requestGatewayRestartWithSignalAdmission: RestartModule["requestGatewayRestartWithSignalAdmission"];
let scheduleGatewaySigusr1Restart: RestartModule["scheduleGatewaySigusr1Restart"];
let setGatewaySigusr1RestartPolicy: RestartModule["setGatewaySigusr1RestartPolicy"];
let setPreRestartDeferralCheck: RestartModule["setPreRestartDeferralCheck"];
let freshRestartModuleId = 0;

const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const findGatewayPidsOnPortSyncMock = vi.hoisted(() => vi.fn());

vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) =>
    cleanStaleGatewayProcessesSyncMock(...args),
  findGatewayPidsOnPortSync: (...args: unknown[]) => findGatewayPidsOnPortSyncMock(...args),
}));

vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function withoutSigusr1Listeners(fn: () => void): void {
  const listeners = process.listeners("SIGUSR1");
  process.removeAllListeners("SIGUSR1");
  try {
    fn();
  } finally {
    process.removeAllListeners("SIGUSR1");
    for (const listener of listeners) {
      process.on("SIGUSR1", listener);
    }
  }
}

function withRestartSupervisorEnabled(fn: () => void): void {
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  try {
    fn();
  } finally {
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
}

function countSigusr1Emits(calls: readonly unknown[][]): number {
  let count = 0;
  for (const args of calls) {
    if (args[0] === "SIGUSR1") {
      count += 1;
    }
  }
  return count;
}

describe("infra runtime", () => {
  function setupRestartSignalSuite() {
    beforeEach(async () => {
      const restart = await importFreshModule<RestartModule>(
        import.meta.url,
        `./restart.js?infra-runtime=${freshRestartModuleId++}`,
      );
      ({
        consumeGatewaySigusr1RestartIntent,
        consumeGatewaySigusr1RestartAuthorization,
        deferGatewayRestartUntilIdle,
        isGatewaySigusr1RestartExternallyAllowed,
        markGatewaySigusr1RestartHandled,
        peekGatewaySigusr1RestartReason,
        requestGatewayRestartWithSignalAdmission,
        scheduleGatewaySigusr1Restart,
        setGatewaySigusr1RestartPolicy,
        setPreRestartDeferralCheck,
      } = restart);
      relaunchGatewayScheduledTaskMock.mockReset();
      relaunchGatewayScheduledTaskMock.mockReturnValue({ ok: true, method: "schtasks" });
      cleanStaleGatewayProcessesSyncMock.mockReset();
      cleanStaleGatewayProcessesSyncMock.mockReturnValue([]);
      findGatewayPidsOnPortSyncMock.mockReset();
      findGatewayPidsOnPortSyncMock.mockReturnValue([]);
      setGatewaySigusr1RestartPolicy({ allowExternal: false });
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      vi.clearAllTimers();
      markGatewaySigusr1RestartHandled();
      resetGatewayWorkAdmission();
      clearRuntimeConfigSnapshot();
      vi.useRealTimers();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
      vi.restoreAllMocks();
    });
  }

  describe("restart authorization", () => {
    setupRestartSignalSuite();

    it("authorizes exactly once when scheduled restart emits", async () => {
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      scheduleGatewaySigusr1Restart({ delayMs: 0 });

      // No pre-authorization before the scheduled emission fires.
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      await vi.runAllTimersAsync();
    });

    it("holds root admission from scheduled emission until the signal is handled", async () => {
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);

        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

        markGatewaySigusr1RestartHandled();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        const root = tryBeginGatewayRootWorkAdmission();
        expect(root).not.toBeNull();
        root?.release();
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("backs off before an emoji that crosses the restart reason limit", () => {
      const restart = scheduleGatewaySigusr1Restart({
        delayMs: 0,
        reason: "x".repeat(199) + "🧠tail",
      });

      expect(restart.reason).toBe("x".repeat(199));
    });

    it("tracks external restart policy", () => {
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
      setGatewaySigusr1RestartPolicy({ allowExternal: true });
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);
    });

    it("suppresses duplicate emit until the restart cycle is marked handled", () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "emitted" });
        expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "coalesced" });
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);

        markGatewaySigusr1RestartHandled();

        expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "emitted" });
        expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(2);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("uses the SIGUSR1 listener path on Windows when the run loop is active", () => {
      setPlatform("win32");
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        expect(requestGatewayRestartWithSignalAdmission()).toEqual({ status: "emitted" });
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("uses the Windows supervisor fallback without leaving a restart cycle in flight", () => {
      setPlatform("win32");
      withoutSigusr1Listeners(() => {
        withRestartSupervisorEnabled(() => {
          relaunchGatewayScheduledTaskMock.mockReturnValueOnce({ ok: true, method: "schtasks" });

          expect(requestGatewayRestartWithSignalAdmission("windows-fallback")).toEqual({
            status: "emitted",
          });

          expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledTimes(1);
          expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
          const next = scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "next" });
          expect(next.coalesced).toBe(false);
          expect(next.mode).toBe("supervisor");
        });
      });
    });

    it("rolls back the Windows supervisor fallback when scheduling fails", () => {
      setPlatform("win32");
      withoutSigusr1Listeners(() => {
        withRestartSupervisorEnabled(() => {
          relaunchGatewayScheduledTaskMock
            .mockReturnValueOnce({ ok: false, method: "schtasks", detail: "denied" })
            .mockReturnValueOnce({ ok: true, method: "schtasks" });

          expect(requestGatewayRestartWithSignalAdmission("windows-fallback")).toEqual({
            status: "failed",
          });
          expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
          expect(requestGatewayRestartWithSignalAdmission("windows-retry")).toEqual({
            status: "emitted",
          });
          expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledTimes(2);
        });
      });
    });

    it("coalesces duplicate scheduled restarts into a single pending timer", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "first" });
        const second = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "second" });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(999);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        await vi.advanceTimersByTimeAsync(1);
        const sigusr1Emits = emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1");
        expect(sigusr1Emits.length).toBe(1);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it.each(["update.run", "update.auto"] as const)(
      "preserves %s restart reason when a scheduled restart coalesces",
      async (reason) => {
        const handler = () => {};
        process.on("SIGUSR1", handler);
        try {
          const first = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "config.patch" });
          const second = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason });

          expect(first.coalesced).toBe(false);
          expect(second.coalesced).toBe(true);

          await vi.advanceTimersByTimeAsync(1_000);

          expect(peekGatewaySigusr1RestartReason()).toBe(reason);
        } finally {
          process.removeListener("SIGUSR1", handler);
        }
      },
    );

    it("promotes update.auto while restart preparation is in flight", async () => {
      let releasePreparation: () => void = () => {};
      const preparationBlocked = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const beforeEmit = vi.fn(async () => {
        await preparationBlocked;
      });
      let resolveSignal: () => void = () => {};
      const signalEmitted = new Promise<void>((resolve) => {
        resolveSignal = resolve;
      });
      const handler = () => resolveSignal();
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "config.patch",
          emitHooks: { beforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(beforeEmit).toHaveBeenCalledTimes(1);

        const update = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "update.auto",
          skipDeferral: true,
        });
        expect(update.coalesced).toBe(true);

        releasePreparation();
        await signalEmitted;

        expect(peekGatewaySigusr1RestartReason()).toBe("update.auto");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("runs restart preparation only when the scheduled restart emits", async () => {
      const beforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          emitHooks: { beforeEmit },
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(beforeEmit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("uses the latest preparation hook when scheduled restarts coalesce", async () => {
      const firstBeforeEmit = vi.fn(async () => {});
      const latestBeforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "first",
          emitHooks: { beforeEmit: firstBeforeEmit },
        });
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "second",
          emitHooks: { beforeEmit: latestBeforeEmit },
        });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(firstBeforeEmit).not.toHaveBeenCalled();
        expect(latestBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("reports emitHooksQueued=false for hookless coalesced restart requests", () => {
      const first = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "first" });
      const second = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "second" });

      expect(first.coalesced).toBe(false);
      expect(first.emitHooksQueued).toBe(false);
      expect(second.coalesced).toBe(true);
      expect(second.emitHooksQueued).toBe(false);
    });

    it("rejects coalesced emit hooks from a different session and reports emitHooksQueued=false (#86742)", async () => {
      const sessionAHooks = vi.fn(async () => {});
      const sessionBHooks = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: sessionAHooks },
        });
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-B",
          sessionKey: "agent:main:session-B",
          emitHooks: { beforeEmit: sessionBHooks },
        });

        expect(first.coalesced).toBe(false);
        expect(first.emitHooksQueued).toBe(true);
        expect(second.coalesced).toBe(true);
        expect(second.emitHooksQueued).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);

        // Session A's hook ran (it owns the pending slot); session B's hook is dropped,
        // which the caller already observed via emitHooksQueued=false.
        expect(sessionAHooks).toHaveBeenCalledTimes(1);
        expect(sessionBHooks).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("allows same-session coalesced restart to replace its own preparation hook (#86742)", async () => {
      const firstHooks = vi.fn(async () => {});
      const latestHooks = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "first",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: firstHooks },
        });
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "second",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: latestHooks },
        });

        expect(first.emitHooksQueued).toBe(true);
        expect(second.coalesced).toBe(true);
        expect(second.emitHooksQueued).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        // Same session: latest hooks take ownership (existing debounce semantics).
        expect(firstHooks).not.toHaveBeenCalled();
        expect(latestHooks).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("rejects earlier reschedule hooks from a different session (#86742)", async () => {
      const sessionAHooks = vi.fn(async () => {});
      const sessionBHooks = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: sessionAHooks },
        });
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "session-B",
          sessionKey: "agent:main:session-B",
          emitHooks: { beforeEmit: sessionBHooks },
        });

        expect(first.coalesced).toBe(false);
        expect(first.emitHooksQueued).toBe(true);
        expect(second.coalesced).toBe(true);
        expect(second.emitHooksQueued).toBe(false);
        expect(second.delayMs).toBe(0);

        await vi.advanceTimersByTimeAsync(0);

        expect(sessionAHooks).toHaveBeenCalledTimes(1);
        expect(sessionBHooks).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("rejects coalesced emit hooks from a different session while preparation is in flight (#86742)", async () => {
      // Pins the CWE-200 in-flight preparation race: pendingRestartSessionKey
      // must stay alive through await beforeEmit(), otherwise a coalesced
      // different-session caller slips past updatePendingRestartEmitHooks
      // and chains its own hooks while preparation runs.
      let releaseSessionAPrep: () => void = () => {};
      const sessionAPrepBlocked = new Promise<void>((resolve) => {
        releaseSessionAPrep = resolve;
      });
      const sessionAHooks = vi.fn(async () => {
        await sessionAPrepBlocked;
      });
      const sessionBHooks = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: sessionAHooks },
        });
        // Advance the scheduled timer so session A's beforeEmit starts and
        // pendingRestartPreparing becomes true; the hook awaits forever until
        // we resolve sessionAPrepBlocked below.
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
        expect(sessionAHooks).toHaveBeenCalledTimes(1);

        // Session B coalesces *during* session A's beforeEmit await window.
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-B",
          sessionKey: "agent:main:session-B",
          emitHooks: { beforeEmit: sessionBHooks },
        });

        expect(first.emitHooksQueued).toBe(true);
        expect(second.coalesced).toBe(true);
        expect(second.emitHooksQueued).toBe(false);

        releaseSessionAPrep();
        await Promise.resolve();
        await Promise.resolve();

        // Session B's hook must NOT run — the guard kept session A as owner
        // through the in-flight preparation window.
        expect(sessionBHooks).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("keeps existing preparation hook when a hookless restart coalesces", async () => {
      const beforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          emitHooks: { beforeEmit },
        });
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "hookless",
        });

        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("keeps restart requests coalesced while preparation is in flight", async () => {
      let releaseFirstPrep: () => void = () => {};
      const firstRollback = vi.fn(async () => {});
      const firstBeforeEmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstPrep = resolve;
          }),
      );
      const latestBeforeEmit = vi.fn(async () => {});
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "first",
          emitHooks: {
            beforeEmit: firstBeforeEmit,
            afterEmitRejected: firstRollback,
          },
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(firstBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        const second = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "second",
          emitHooks: { beforeEmit: latestBeforeEmit },
        });
        expect(second.coalesced).toBe(true);

        releaseFirstPrep();
        await vi.advanceTimersByTimeAsync(0);

        expect(firstRollback).toHaveBeenCalledTimes(1);
        expect(latestBeforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("rolls back prepared restart state when emission is rejected", async () => {
      const beforeEmit = vi.fn(async () => {});
      const afterEmitRejected = vi.fn(async () => {});
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("no signal");
      });

      scheduleGatewaySigusr1Restart({
        delayMs: 0,
        emitHooks: { beforeEmit, afterEmitRejected },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(beforeEmit).toHaveBeenCalledTimes(1);
      expect(afterEmitRejected).toHaveBeenCalledTimes(1);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    });

    it("drains parked emit hooks when a hooked deferral wins the emission race", async () => {
      // Gateway-tool parks sentinel/continuation hooks; config-reload deferral
      // can emit first with its own hooks. Both preparations must run, and
      // session ownership must clear so a later session can claim the slot.
      const parkedBeforeEmit = vi.fn(async () => {});
      const callerBeforeEmit = vi.fn(async () => {});
      const callerEmitRestart = vi.fn(() => ({ status: "emitted" as const }));
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs: 60_000,
          reason: "gateway.tool.restart",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit: parkedBeforeEmit },
        });
        expect(scheduled.emitHooksQueued).toBe(true);

        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: callerBeforeEmit,
            emitRestart: callerEmitRestart,
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(parkedBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerEmitRestart).toHaveBeenCalledTimes(1);
        // Caller preflight precedes the parked drain so late-parked hooks are
        // captured by the drain's tail re-read before emission.
        expect(callerBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
          parkedBeforeEmit.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
        );
        expect(parkedBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
          callerEmitRestart.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
        );

        const followUp = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-B",
          sessionKey: "agent:main:session-B",
          emitHooks: { beforeEmit: vi.fn(async () => {}) },
        });
        expect(followUp.emitHooksQueued).toBe(true);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("rejects parked emit hooks when a hooked emission is not emitted", async () => {
      const parkedBeforeEmit = vi.fn(async () => {});
      const parkedAfterEmitRejected = vi.fn(async () => {});
      const callerBeforeEmit = vi.fn(async () => {});
      const callerAfterEmitRejected = vi.fn(async () => {});
      const callerEmitRestart = vi.fn(() => ({ status: "coalesced" as const }));
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 60_000,
          reason: "gateway.tool.restart",
          sessionKey: "agent:main:session-A",
          emitHooks: {
            beforeEmit: parkedBeforeEmit,
            afterEmitRejected: parkedAfterEmitRejected,
          },
        });

        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: callerBeforeEmit,
            afterEmitRejected: callerAfterEmitRejected,
            emitRestart: callerEmitRestart,
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(parkedBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerEmitRestart).toHaveBeenCalledTimes(1);
        expect(parkedAfterEmitRejected).toHaveBeenCalledTimes(1);
        expect(callerAfterEmitRejected).toHaveBeenCalledTimes(1);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("re-drains hooks accepted while caller preparation awaits", async () => {
      // scheduleGatewaySigusr1Restart is not fence-gated: a session can park
      // hooks (emitHooksQueued: true) while the emitting caller's beforeEmit
      // awaits. Those hooks must ride this restart, not be silently dropped.
      const lateBeforeEmit = vi.fn(async () => {});
      const callerEmitRestart = vi.fn(() => ({ status: "emitted" as const }));
      let lateQueued: boolean | undefined;
      const callerBeforeEmit = vi.fn(async () => {
        if (lateQueued === undefined) {
          lateQueued = scheduleGatewaySigusr1Restart({
            delayMs: 60_000,
            reason: "late.session",
            sessionKey: "agent:main:session-late",
            emitHooks: { beforeEmit: lateBeforeEmit },
          }).emitHooksQueued;
        }
      });
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: callerBeforeEmit,
            emitRestart: callerEmitRestart,
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(lateQueued).toBe(true);
        expect(lateBeforeEmit).toHaveBeenCalledTimes(1);
        expect(callerEmitRestart).toHaveBeenCalledTimes(1);
        expect(lateBeforeEmit.mock.invocationCallOrder[0]).toBeLessThan(
          callerEmitRestart.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
        );
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("runs every afterEmitFailed callback even when an earlier one throws", async () => {
      const parkedAfterEmitFailed = vi.fn(async () => {
        throw new Error("sentinel cleanup failed");
      });
      const callerAfterEmitFailed = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 60_000,
          reason: "gateway.tool.restart",
          sessionKey: "agent:main:session-A",
          emitHooks: {
            beforeEmit: vi.fn(async () => {}),
            afterEmitFailed: parkedAfterEmitFailed,
          },
        });

        deferGatewayRestartUntilIdle({
          getPendingCount: () => 0,
          reason: "config.reload",
          emitHooks: {
            beforeEmit: vi.fn(async () => {}),
            afterEmitFailed: callerAfterEmitFailed,
            emitRestart: () => ({ status: "failed" as const }),
          },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(parkedAfterEmitFailed).toHaveBeenCalledTimes(1);
        expect(callerAfterEmitFailed).toHaveBeenCalledTimes(1);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("still emits restart when preparation fails", async () => {
      const beforeEmit = vi.fn(async () => {
        throw new Error("state dir readonly");
      });
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({
          delayMs: 0,
          emitHooks: { beforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("applies restart cooldown between emitted restart cycles", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "first" });
        expect(first.coalesced).toBe(false);
        expect(first.delayMs).toBe(0);

        await vi.advanceTimersByTimeAsync(0);
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
        markGatewaySigusr1RestartHandled();

        const second = scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "second" });
        expect(second.coalesced).toBe(false);
        expect(second.delayMs).toBe(30_000);
        expect(second.cooldownMsApplied).toBe(30_000);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(2);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("bypasses restart cooldown when requested", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "first" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
        markGatewaySigusr1RestartHandled();

        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "update.run",
          skipCooldown: true,
        });

        expect(forced.coalesced).toBe(false);
        expect(forced.delayMs).toBe(0);
        expect(forced.cooldownMsApplied).toBe(0);

        await vi.advanceTimersByTimeAsync(0);
        expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(2);
        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });
  });

  describe("pre-restart deferral check", () => {
    setupRestartSignalSuite();

    it("emits SIGUSR1 immediately when no deferral check is registered", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 immediately when deferral check returns 0", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 0);
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("defers SIGUSR1 until deferral check returns 0", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        let pending = 2;
        setPreRestartDeferralCheck(() => pending);
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        // After initial delay fires, deferral check returns 2 — should NOT emit yet
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // After one poll (500ms), still pending
        await vi.advanceTimersByTimeAsync(500);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // Drain pending work
        pending = 0;
        await vi.advanceTimersByTimeAsync(500);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("bypasses the pre-restart deferral check when requested", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const pendingCheck = vi.fn(() => 5);
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(pendingCheck);
        scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "update.run",
          skipDeferral: true,
        });

        await vi.advanceTimersByTimeAsync(0);

        expect(pendingCheck).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("upgrades an already scheduled restart to bypass deferral", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const pendingCheck = vi.fn(() => 5);
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(pendingCheck);
        scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "config.patch" });
        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "update.run",
          skipDeferral: true,
        });

        expect(forced.coalesced).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(pendingCheck).not.toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("preserves a session-owned preparation hook when a hookless forced restart pulls a pending timer earlier (#86742)", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const beforeEmit = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const pending = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit },
        });
        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 1_000,
          preservePendingEmitHooksOnDeferralBypass: true,
          reason: "gateway.restart.safe",
          skipDeferral: true,
        });

        expect(pending.emitHooksQueued).toBe(true);
        expect(forced.coalesced).toBe(false);
        expect(forced.emitHooksQueued).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(beforeEmit).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(peekGatewaySigusr1RestartReason()).toBe("gateway.restart.safe");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("bypasses an active restart deferral when a forced restart arrives", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const staleBeforeEmit = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5);
        scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "config.patch",
          emitHooks: { beforeEmit: staleBeforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "update.run",
          skipDeferral: true,
        });

        expect(forced.coalesced).toBe(false);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(staleBeforeEmit).not.toHaveBeenCalled();
        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("clears a session-owned preparation hook when a forced update owns the sentinel (#86742)", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const beforeEmit = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5);
        scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "update.run",
          skipDeferral: true,
        });

        expect(forced.coalesced).toBe(false);
        expect(forced.emitHooksQueued).toBe(false);
        expect(beforeEmit).not.toHaveBeenCalled();
        await Promise.resolve();
        await Promise.resolve();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("preserves a session-owned preparation hook when a hookless forced restart bypasses active deferral (#86742)", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const beforeEmit = vi.fn(async () => {});
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5);
        const pending = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          reason: "session-A",
          sessionKey: "agent:main:session-A",
          emitHooks: { beforeEmit },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        const forced = scheduleGatewaySigusr1Restart({
          delayMs: 0,
          preservePendingEmitHooksOnDeferralBypass: true,
          reason: "gateway.restart.safe",
          skipDeferral: true,
        });

        expect(pending.emitHooksQueued).toBe(true);
        expect(forced.coalesced).toBe(false);
        expect(forced.emitHooksQueued).toBe(false);
        expect(beforeEmit).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(peekGatewaySigusr1RestartReason()).toBe("gateway.restart.safe");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 after the default deferral timeout while work is still pending", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        // Fire initial timeout
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        await vi.advanceTimersByTimeAsync(300_000);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("keeps SIGUSR1 deferred when deferral timeout is explicitly disabled", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setRuntimeConfigSnapshot({ gateway: { reload: { deferralTimeoutMs: 0 } } });
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        await vi.advanceTimersByTimeAsync(300_000);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 after explicit deferral timeout even if still pending", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setRuntimeConfigSnapshot({ gateway: { reload: { deferralTimeoutMs: 1_000 } } });
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        await vi.advanceTimersByTimeAsync(1_000);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
        expect(consumeGatewaySigusr1RestartIntent()).toEqual({
          force: true,
        });
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 if deferral check throws", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => {
          throw new Error("boom");
        });
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });
  });
});
