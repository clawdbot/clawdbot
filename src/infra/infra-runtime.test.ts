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
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";
import { listTailnetAddresses } from "./tailnet.js";

describe("infra runtime", () => {
  function setupRestartSignalSuite() {
    beforeEach(() => {
      __testing.resetSigusr1State();
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(async () => {
      __testing.resetSigusr1State();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
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

    it("keeps SIGUSR1 deferred by default while work is still pending", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        // Fire initial timeout
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // No default max deferral wait; active turns should not be killed just
        // because a config-triggered restart has been pending for 5 minutes.
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
