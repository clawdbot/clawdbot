import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  emitGatewayRestart,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  peekGatewaySigusr1RestartReason,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";
import { listTailnetAddresses } from "./tailnet.js";

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

describe("infra runtime", () => {
  function setupRestartSignalSuite() {
    beforeEach(() => {
      __testing.resetSigusr1State();
      relaunchGatewayScheduledTaskMock.mockReset();
      relaunchGatewayScheduledTaskMock.mockReturnValue({ ok: true, method: "schtasks" });
      cleanStaleGatewayProcessesSyncMock.mockReset();
      cleanStaleGatewayProcessesSyncMock.mockReturnValue([]);
      findGatewayPidsOnPortSyncMock.mockReset();
      findGatewayPidsOnPortSyncMock.mockReturnValue([]);
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(async () => {
      __testing.resetSigusr1State();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await vi.runOnlyPendingTimersAsync();
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
        expect(emitGatewayRestart()).toBe(true);
        expect(emitGatewayRestart()).toBe(false);
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);

        markGatewaySigusr1RestartHandled();

        expect(emitGatewayRestart()).toBe(true);
        const sigusr1Emits = emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1");
        expect(sigusr1Emits.length).toBe(2);
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
        expect(emitGatewayRestart()).toBe(true);
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

          expect(emitGatewayRestart("windows-fallback")).toBe(true);

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

          expect(emitGatewayRestart("windows-fallback")).toBe(false);
          expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
          expect(emitGatewayRestart("windows-retry")).toBe(true);
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

    it("preserves update restart reason when a scheduled restart coalesces", async () => {
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "config.patch" });
        const second = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "update.run" });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(peekGatewaySigusr1RestartReason()).toBe("update.run");
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
        expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1").length).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1").length).toBe(2);
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
        expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1").length).toBe(2);
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

  describe("tailnet address detection", () => {
    it("detects tailscale IPv4 and IPv6 addresses", () => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(
        makeNetworkInterfacesSnapshot({
          lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          utun9: [
            { address: "100.123.224.76", family: "IPv4" },
            { address: "fd7a:115c:a1e0::8801:e04c", family: "IPv6" },
          ],
        }),
      );

      const out = listTailnetAddresses();
      expect(out.ipv4).toEqual(["100.123.224.76"]);
      expect(out.ipv6).toEqual(["fd7a:115c:a1e0::8801:e04c"]);
    });
  });
});
