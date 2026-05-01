import { describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { __testing } from "./run.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("supervised gateway lock recovery", () => {
  it("does not retry gateway lock errors outside a supervisor", async () => {
    const err = new GatewayLockError("gateway already running");
    const startLoop = vi.fn(async () => {
      throw err;
    });

    await expect(
      __testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: null,
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
      }),
    ).rejects.toBe(err);

    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it("leaves a healthy launchd-supervised gateway in control", async () => {
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("gateway already running");
    });
    const probeHealth = vi.fn(async () => true);
    const log = createLogger();

    await __testing.runGatewayLoopWithSupervisedLockRecovery({
      startLoop,
      supervisor: "launchd",
      port: 18789,
      healthHost: "0.0.0.0",
      log,
      probeHealth,
    });

    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeHealth).toHaveBeenCalledWith({ host: "0.0.0.0", port: 18789 });
    expect(log.info).toHaveBeenCalledWith(
      "gateway already running under launchd; existing gateway is healthy, leaving it in control",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses exit 78 semantics for healthy systemd-supervised lock conflicts", async () => {
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("another gateway instance is already listening");
    });
    const probeHealth = vi.fn(async () => true);

    await expect(
      __testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeHealth,
      }),
    ).rejects.toThrow("exiting with code 78 to prevent a systemd Restart=always loop");

    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeHealth).toHaveBeenCalledWith({ host: "127.0.0.1", port: 18789 });
    expect(
      __testing.resolveGatewayLockErrorExitCode(
        new GatewayLockError("gateway already running under systemd; existing gateway is healthy"),
        "systemd",
      ),
    ).toBe(78);
  });

  it("bounds supervised retries when the existing gateway stays unhealthy", async () => {
    let now = 0;
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("gateway already running");
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(
      __testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeHealth: vi.fn(async () => false),
        now: () => now,
        sleep,
        retryMs: 5,
        timeoutMs: 12,
      }),
    ).rejects.toThrow(
      "gateway already running under systemd; existing gateway did not become healthy after 12ms",
    );

    expect(startLoop).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 5);
    expect(sleep).toHaveBeenNthCalledWith(3, 2);
  });

  it("bounds supervised retries for EADDRINUSE lock errors", async () => {
    let now = 0;
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError(
        "another gateway instance is already listening on ws://127.0.0.1:18789",
      );
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(
      __testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeHealth: vi.fn(async () => false),
        now: () => now,
        sleep,
        retryMs: 5,
        timeoutMs: 12,
      }),
    ).rejects.toThrow(
      "gateway already running under systemd; existing gateway did not become healthy after 12ms",
    );

    expect(startLoop).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 5);
    expect(sleep).toHaveBeenNthCalledWith(3, 2);
  });

  it("keeps unmanaged duplicate starts on the existing exit-success path", () => {
    expect(
      __testing.resolveGatewayLockErrorExitCode(
        new GatewayLockError("another gateway instance is already listening"),
        null,
      ),
    ).toBe(0);
  });

  it("normalizes wildcard bind hosts for local health probes", () => {
    expect(__testing.normalizeGatewayHealthProbeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(__testing.normalizeGatewayHealthProbeHost("::")).toBe("127.0.0.1");
    expect(__testing.normalizeGatewayHealthProbeHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
