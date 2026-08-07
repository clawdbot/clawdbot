// Externally supervised gateway restart polling tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectPortUsage,
  mockGatewayLockReplacement,
  probeGateway,
  readActiveGatewayLockIdentity,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it("does not accept listener health until the gateway lock owner changes", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4200, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.7.16", connId: "gateway" },
    });
    const previousLockIdentity = mockGatewayLockReplacement();

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      previousLockIdentity,
      attempts: 2,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
    expect(inspectPortUsage).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([
    { listenerPid: 4300, healthy: true },
    { listenerPid: 4400, healthy: false },
  ])(
    "accepts device identity policy close only for the verified replacement listener",
    async ({ listenerPid, healthy }) => {
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: listenerPid, commandLine: "openclaw-gateway" }],
        hints: [],
      });
      probeGateway.mockResolvedValue({
        ok: false,
        close: { code: 1008, reason: "device identity required" },
      });
      const previousLockIdentity = mockGatewayLockReplacement({ pid: 4300 });

      const { waitForGatewayHealthyListener } = await import("./restart-health.js");
      const snapshot = await waitForGatewayHealthyListener({
        port: 18789,
        previousLockIdentity,
        attempts: 1,
        delayMs: 500,
      });

      expect(snapshot.healthy).toBe(healthy);
      expect(inspectPortUsage).toHaveBeenCalledTimes(1);
      expect(probeGateway).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds replacement health after an indefinite previous-owner wait", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const previousLockIdentity = mockGatewayLockReplacement();

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      previousLockIdentity,
      attempts: 2,
      delayMs: 500,
      waitIndefinitelyForPreviousOwner: true,
    });

    expect(snapshot.healthy).toBe(false);
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
    expect(inspectPortUsage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("reports still-starting when the restarted process is alive and the port is free", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
      previousOwnerPid: 4200,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("still-starting");
    expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(killSpy).toHaveBeenCalledWith(4200, 0);
  });

  it("reports timeout when the restarted process is no longer alive", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
      previousOwnerPid: 4200,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
  });

  it("reports timeout instead of still-starting when the boot lifecycle recorded startup_failed", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { readLatestGatewayBootOutcome } = await import("./restart-health.test-helpers.js");
    readLatestGatewayBootOutcome.mockReturnValue("startup_failed");

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
      previousOwnerPid: 4200,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(killSpy).toHaveBeenCalledWith(4200, 0);
    expect(readLatestGatewayBootOutcome).toHaveBeenCalled();
  });

  it("keeps still-starting when the boot lifecycle has no recorded failure", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { readLatestGatewayBootOutcome } = await import("./restart-health.test-helpers.js");
    readLatestGatewayBootOutcome.mockReturnValue(null);

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
      previousOwnerPid: 4200,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("still-starting");
  });

  it("keeps the healthy outcome for a reachable listener", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4200, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.7.16", connId: "gateway" },
    });

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
      previousOwnerPid: 4200,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.waitOutcome).toBe("healthy");
  });
});
