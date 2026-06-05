// Measure Rpc Rtt tests cover measure rpc rtt script behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupTempRoot,
  installGatewayParentCleanup,
  isGatewayProcessAlive,
  signalGatewayProcess,
  startGateway,
  stopGateway,
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
        sourceEntryExists: () => true,
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
      process.execPath,
      [
        "--import",
        "tsx",
        "/repo/src/entry.ts",
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
        detached: process.platform !== "win32",
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

  it("signals the gateway process group on POSIX so pnpm children do not leak", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => true);

    expect(signalGatewayProcess(child, "SIGTERM", kill)).toBe(true);

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("treats missing gateway process groups as already exited", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => false),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    expect(signalGatewayProcess(child, "SIGTERM", kill)).toBe(false);
  });

  it("checks process group liveness instead of only the pnpm wrapper", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      kill: vi.fn(),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => true);

    if (process.platform === "win32") {
      expect(isGatewayProcessAlive(child, kill)).toBe(false);
    } else {
      expect(isGatewayProcessAlive(child, kill)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-12345, 0);
    }
  });

  it("force-kills the gateway process group after the graceful stop window", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12346,
      signalCode: null,
    });
    const kill = vi.fn(() => true);

    await stopGateway(child, { killGraceMs: 1, killProcess: kill });

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12346, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -12346, "SIGTERM");
      expect(kill).toHaveBeenLastCalledWith(-12346, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("does not trust a finished pnpm wrapper while the process group is alive", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      kill: vi.fn(),
      pid: 12347,
      signalCode: null,
    });
    const kill = vi.fn(() => true);

    await stopGateway(child, { killGraceMs: 1, killProcess: kill });

    if (process.platform === "win32") {
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12347, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -12347, "SIGTERM");
      expect(kill).toHaveBeenLastCalledWith(-12347, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("cleans up the gateway process group before re-raising parent signals", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12348,
      signalCode: null,
    });
    const processLike = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 98765,
    });
    const kill = vi.fn(() => true);

    const removeCleanup = installGatewayParentCleanup(child, {
      killProcess: kill,
      processLike,
    });
    processLike.emit("SIGTERM");

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12348, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -12348, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
    expect(processLike.kill).toHaveBeenCalledWith(98765, "SIGTERM");
    expect(processLike.listenerCount("SIGTERM")).toBe(0);

    removeCleanup();
  });

  it("cleans up the gateway process group on parent exit", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12349,
      signalCode: null,
    });
    const processLike = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 98766,
    });
    const kill = vi.fn(() => true);

    const removeCleanup = installGatewayParentCleanup(child, {
      killProcess: kill,
      processLike,
    });
    processLike.emit("exit");

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12349, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -12349, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
    expect(processLike.kill).not.toHaveBeenCalled();

    removeCleanup();
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
