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

  it("leaves a healthy supervised gateway in control", async () => {
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("gateway already running");
    });
    const probeHealth = vi.fn(async () => true);
    const log = createLogger();

    await __testing.runGatewayLoopWithSupervisedLockRecovery({
      startLoop,
      supervisor: "systemd",
      port: 18789,
      healthHost: "0.0.0.0",
      log,
      probeHealth,
    });

    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeHealth).toHaveBeenCalledWith({ host: "0.0.0.0", port: 18789 });
    expect(log.info).toHaveBeenCalledWith(
      "gateway already running under systemd; existing gateway is healthy, leaving it in control",
    );
    expect(log.warn).not.toHaveBeenCalled();
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

  it("normalizes wildcard bind hosts for local health probes", () => {
    expect(__testing.normalizeGatewayHealthProbeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(__testing.normalizeGatewayHealthProbeHost("::")).toBe("127.0.0.1");
    expect(__testing.normalizeGatewayHealthProbeHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
