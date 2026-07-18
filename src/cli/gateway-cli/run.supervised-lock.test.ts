// Gateway supervised lock tests cover single-runner locking for supervised gateway starts.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { testing } from "./run.test-support.js";

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
      testing.runGatewayLoopWithSupervisedLockRecovery({
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

    await testing.runGatewayLoopWithSupervisedLockRecovery({
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
      testing.runGatewayLoopWithSupervisedLockRecovery({
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
      testing.resolveGatewayLockErrorExitCode(
        new GatewayLockError("gateway already running under systemd; existing gateway is healthy"),
        "systemd",
        true,
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
      testing.runGatewayLoopWithSupervisedLockRecovery({
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
      testing.runGatewayLoopWithSupervisedLockRecovery({
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

  it("requires a confirmed healthy gateway for unmanaged duplicate starts", () => {
    const err = new GatewayLockError("another gateway instance is already listening");

    expect(testing.resolveGatewayLockErrorExitCode(err, null, false)).toBe(1);
    expect(testing.resolveGatewayLockErrorExitCode(err, null, true)).toBe(0);
  });

  it("recognizes only the OpenClaw health response", () => {
    expect(
      testing.isGatewayHealthzResponse(200, JSON.stringify({ ok: true, status: "live" })),
    ).toBe(true);
    expect(
      testing.isGatewayHealthzResponse(200, JSON.stringify({ ok: true, status: "ready" })),
    ).toBe(false);
    expect(testing.isGatewayHealthzResponse(404, "not found")).toBe(false);
    expect(testing.isGatewayHealthzResponse(200, "not json")).toBe(false);
  });

  it("bounds slow health responses with an absolute deadline", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => {
        res.write(" ");
      }, 10);
      res.once("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const startedAt = Date.now();
      await expect(
        testing.probeGatewayHealthz({
          host: "127.0.0.1",
          port: address.port,
          timeoutMs: 50,
        }),
      ).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("normalizes wildcard bind hosts for local health probes", () => {
    expect(testing.normalizeGatewayHealthProbeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(testing.normalizeGatewayHealthProbeHost("::")).toBe("127.0.0.1");
    expect(testing.normalizeGatewayHealthProbeHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
