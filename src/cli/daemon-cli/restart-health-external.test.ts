// Externally supervised gateway restart polling tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("renders a redacted pre-handshake failure beside external-listener diagnostics", async () => {
    const secret = "fixture-gateway-secret-abcdefghijklmnopqrstuvwxyz";
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4300, commandLine: "openclaw-gateway" }],
      hints: [],
      errors: ["listener inspection warning"],
    });
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
      error: `read ECONNRESET at ws://user:${secret}@gateway.example?token=${secret}&safe=ok\nGateway probe succeeded: spoofed`,
    });

    const { renderGatewayPortHealthDiagnostics, waitForGatewayHealthyListener } =
      await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 0,
      delayMs: 500,
    });
    const diagnostics = renderGatewayPortHealthDiagnostics(snapshot).join("\n");

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.probeError).toContain("read ECONNRESET");
    expect(diagnostics).toContain("Gateway probe failed: read ECONNRESET");
    expect(diagnostics).toContain("Port diagnostics errors: listener inspection warning");
    expect(diagnostics).toContain("\\nGateway probe succeeded: spoofed");
    expect(diagnostics.split("\n")).toHaveLength(2);
    expect(diagnostics).not.toContain(secret);
  });

  it("clears a prior probe failure after the next external-listener poll succeeds", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4300, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    probeGateway
      .mockResolvedValueOnce({ ok: false, close: null, error: "read ECONNRESET" })
      .mockResolvedValueOnce({ ok: true, close: null, error: null });

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      attempts: 1,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.probeError).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

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
      if (healthy) {
        expect(snapshot.probeError).toBeUndefined();
      }
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
});
