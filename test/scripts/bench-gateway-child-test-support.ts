// Gateway benchmark child test support simulates child process behavior for script tests.
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

type StopChildResult = {
  exitedBeforeTeardown: boolean;
  exitCode: number | null;
  signal: string | null;
};

type StopChild<TChild> = (
  child: TChild,
  options?: {
    killGraceMs?: number;
    platform?: NodeJS.Platform;
    runTaskkill?: typeof spawnSync;
    teardownGraceMs?: number;
  },
) => Promise<StopChildResult>;

export function registerStopChildBehaviorTests<TChild>(params: {
  stopChild: StopChild<TChild>;
  queuedExitCode: number;
}) {
  it("classifies queued child exits before sending teardown signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);

    const stopped = params.stopChild(child as unknown as TChild);
    queueMicrotask(() => {
      child.exitCode = params.queuedExitCode;
      child.emit("exit", params.queuedExitCode, null);
    });

    await expect(stopped).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: params.queuedExitCode,
      signal: null,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("classifies failed teardown signaling as a pre-teardown child exit", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      setImmediate(() => {
        child.exitCode = 8;
        child.emit("exit", 8, null);
      });
      return false;
    });

    await expect(params.stopChild(child as unknown as TChild)).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: 8,
      signal: null,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds teardown when the child ignores termination signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();

    await expect(
      params.stopChild(child as unknown as TChild, {
        killGraceMs: 1,
        teardownGraceMs: 1,
      }),
    ).resolves.toEqual({
      exitedBeforeTeardown: false,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("signals Windows child process trees with taskkill", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.kill = vi.fn(() => true);
    child.pid = 4450;
    child.signalCode = null;
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    await expect(
      params.stopChild(child as unknown as TChild, {
        killGraceMs: 1,
        platform: "win32",
        runTaskkill: runTaskkill as unknown as typeof spawnSync,
        teardownGraceMs: 1,
      }),
    ).resolves.toEqual({
      exitedBeforeTeardown: false,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "4450", "/T"], {
      stdio: "ignore",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "4450", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("force-kills Windows child process trees when graceful taskkill fails", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.kill = vi.fn(() => true);
    child.pid = 4450;
    child.signalCode = null;
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    await expect(
      params.stopChild(child as unknown as TChild, {
        killGraceMs: 1,
        platform: "win32",
        runTaskkill,
        teardownGraceMs: 1,
      }),
    ).resolves.toEqual({
      exitedBeforeTeardown: false,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "4450", "/T"], {
      stdio: "ignore",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "4450", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      3,
      expectedTaskkillPath(),
      ["/PID", "4450", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "preserves pre-teardown wrapper exits while cleaning the process group",
    async () => {
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        kill: ReturnType<typeof vi.fn>;
        pid: number;
        signalCode: NodeJS.Signals | null;
        stderr: { destroy: ReturnType<typeof vi.fn> };
        stdin: { destroy: ReturnType<typeof vi.fn> };
        stdout: { destroy: ReturnType<typeof vi.fn> };
        unref: ReturnType<typeof vi.fn>;
      };
      child.exitCode = null;
      child.kill = vi.fn(() => true);
      child.pid = 4444;
      child.signalCode = null;
      child.stderr = { destroy: vi.fn() };
      child.stdin = { destroy: vi.fn() };
      child.stdout = { destroy: vi.fn() };
      child.unref = vi.fn();

      let processGroupAlive = true;
      const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(-child.pid);
        if (signal === "SIGKILL") {
          processGroupAlive = false;
          return true;
        }
        if (signal === 0 && !processGroupAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      });
      try {
        const stopped = params.stopChild(child as unknown as TChild, {
          killGraceMs: 50,
          teardownGraceMs: 1,
        });
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
        await expect(stopped).resolves.toEqual({
          exitedBeforeTeardown: true,
          exitCode: 0,
          signal: null,
        });
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.stdin.destroy).not.toHaveBeenCalled();
        expect(child.stdout.destroy).not.toHaveBeenCalled();
        expect(child.stderr.destroy).not.toHaveBeenCalled();
        expect(child.unref).not.toHaveBeenCalled();
      } finally {
        processKill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for the process group after a teardown-triggered wrapper exit",
    async () => {
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        kill: ReturnType<typeof vi.fn>;
        pid: number;
        signalCode: NodeJS.Signals | null;
        stderr: { destroy: ReturnType<typeof vi.fn> };
        stdin: { destroy: ReturnType<typeof vi.fn> };
        stdout: { destroy: ReturnType<typeof vi.fn> };
        unref: ReturnType<typeof vi.fn>;
      };
      child.exitCode = null;
      child.kill = vi.fn(() => true);
      child.pid = 4445;
      child.signalCode = null;
      child.stderr = { destroy: vi.fn() };
      child.stdin = { destroy: vi.fn() };
      child.stdout = { destroy: vi.fn() };
      child.unref = vi.fn();

      let emittedExit = false;
      let processGroupAlive = true;
      const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(-child.pid);
        if (signal === "SIGTERM" && !emittedExit) {
          emittedExit = true;
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          });
        }
        if (signal === "SIGKILL") {
          processGroupAlive = false;
          return true;
        }
        if (signal === 0 && !processGroupAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      });
      try {
        await expect(
          params.stopChild(child as unknown as TChild, {
            killGraceMs: 50,
            teardownGraceMs: 1,
          }),
        ).resolves.toEqual({
          exitedBeforeTeardown: false,
          exitCode: 0,
          signal: null,
        });
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.stdin.destroy).not.toHaveBeenCalled();
        expect(child.stdout.destroy).not.toHaveBeenCalled();
        expect(child.stderr.destroy).not.toHaveBeenCalled();
        expect(child.unref).not.toHaveBeenCalled();
      } finally {
        processKill.mockRestore();
      }
    },
  );
}
import type { spawnSync } from "node:child_process";
