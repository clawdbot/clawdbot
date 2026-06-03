import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupTempRoot,
  startGateway,
  waitForGatewayReady,
} from "../../scripts/measure-rpc-rtt.mjs";

describe("scripts/measure-rpc-rtt.mjs", () => {
  it("closes parent gateway log handles after spawning", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    const stdout = { close: vi.fn().mockResolvedValue(undefined), fd: 41 };
    const stderr = { close: vi.fn().mockResolvedValue(undefined), fd: 42 };
    const openImpl = vi.fn().mockResolvedValueOnce(stdout).mockResolvedValueOnce(stderr);
    const spawnImpl = vi.fn().mockReturnValue(child);

    await expect(
      startGateway({
        configPath: "/tmp/openclaw.json",
        env: { PATH: "/bin" },
        openImpl,
        port: 23456,
        repoRoot: "/repo",
        spawnImpl,
        stderrPath: "/tmp/stderr.log",
        stdoutPath: "/tmp/stdout.log",
        tempRoot: "/tmp/rpc-rtt",
        token: "secret-token",
      }),
    ).resolves.toBe(child);

    expect(openImpl).toHaveBeenNthCalledWith(1, "/tmp/stdout.log", "w");
    expect(openImpl).toHaveBeenNthCalledWith(2, "/tmp/stderr.log", "w");
    expect(spawnImpl).toHaveBeenCalledWith(
      "pnpm",
      [
        "openclaw",
        "gateway",
        "run",
        "--port",
        "23456",
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          HOME: "/tmp/rpc-rtt/home",
          OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: "/tmp/rpc-rtt/state",
          PATH: "/bin",
        }),
        stdio: ["ignore", 41, 42],
      }),
    );
    expect(stdout.close).toHaveBeenCalledTimes(1);
    expect(stderr.close).toHaveBeenCalledTimes(1);
  });

  it("fails readiness immediately when the gateway already exited", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null,
    });
    const fetchImpl = vi.fn();

    await expect(
      waitForGatewayReady({
        child,
        fetchImpl,
        port: 12345,
        readyTimeoutMs: 10_000,
        sleepMs: 1,
        stderrPath: "/no/such/stderr.log",
      }),
    ).rejects.toThrow("gateway exited before readiness code=1 signal=null");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces temp root cleanup failures", async () => {
    const rmImpl = vi.fn().mockRejectedValue(new Error("device busy"));

    await expect(cleanupTempRoot("/tmp/rpc-rtt-stuck", { rmImpl })).rejects.toThrow(
      "failed to remove RPC RTT temp root: device busy",
    );
    expect(rmImpl).toHaveBeenCalledWith("/tmp/rpc-rtt-stuck", {
      force: true,
      recursive: true,
    });
  });

  it("bounds readiness probes and keeps polling after a stalled response", async () => {
    const child = new EventEmitter();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"))
      .mockResolvedValueOnce({ ok: true });

    await waitForGatewayReady({
      child,
      fetchImpl,
      port: 12345,
      probeTimeoutMs: 7,
      readyTimeoutMs: 50,
      sleepMs: 1,
      stderrPath: "/no/such/stderr.log",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:12345/healthz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
