import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { runNodeWatchedPaths } from "../../scripts/run-node.mjs";
import { runWatchMain } from "../../scripts/watch-node.mjs";
import { withTempDir } from "../test-helpers/temp-dir.js";

const VOICE_CALL_README = bundledPluginFile("voice-call", "README.md");
const VOICE_CALL_MANIFEST = bundledPluginFile("voice-call", "openclaw.plugin.json");
const VOICE_CALL_PACKAGE = bundledPluginFile("voice-call", "package.json");
const VOICE_CALL_INDEX = bundledPluginFile("voice-call", "index.ts");
const VOICE_CALL_RUNTIME = bundledPluginFile("voice-call", "src/runtime.ts");
type WatchRunParams = NonNullable<Parameters<typeof runWatchMain>[0]> & {
  lockDisabled?: boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
};

const runWatch = (params: WatchRunParams) => runWatchMain(params);
const resolveTestWatchLockPath = (cwd: string, args: string[]) =>
  path.join(
    cwd,
    ".local",
    "watch-node",
    `${createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12)}.json`,
  );

const createFakeProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: "/usr/local/bin/node",
  }) as unknown as NodeJS.Process;

const createWatchHarness = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {}),
  });
  const spawn = vi.fn(() => child);
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn(() => watcher);
  const fakeProcess = createFakeProcess();
  return { child, spawn, watcher, createWatcher, fakeProcess };
};

const createAutoExitChild = () => {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  return child;
};

const startWatchRun = ({
  args = ["gateway", "--force"],
  env,
  spawn,
}: {
  args?: string[];
  env?: WatchRunParams["env"];
  spawn: NonNullable<WatchRunParams["spawn"]>;
}) => {
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  });
  const createWatcher = vi.fn(() => watcher);
  const fakeProcess = createFakeProcess();
  const runPromise = runWatch({
    args,
    createWatcher,
    env,
    lockDisabled: true,
    process: fakeProcess,
    spawn,
  });
  return { watcher, createWatcher, fakeProcess, runPromise };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireMockCall(mock: ReturnType<typeof vi.fn>, callIndex: number): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function requireSpawnOptions(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireMockCall(spawn, callIndex)[2], "spawn options");
}

function requireSpawnEnv(spawn: ReturnType<typeof vi.fn>, callIndex: number) {
  return requireRecord(requireSpawnOptions(spawn, callIndex).env, "spawn env");
}

describe("watch-node script", () => {
  it("wires chokidar watch to run-node with watched source/config paths", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-" }, async (cwd) => {
      fs.mkdirSync(path.join(cwd, "src", "infra"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "extensions", "voice-call"), { recursive: true });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd,
        createWatcher,
        env: { PATH: "/usr/bin" },
        lockDisabled: true,
        now: () => 1700000000000,
        process: fakeProcess,
        spawn,
      });

      expect(createWatcher).toHaveBeenCalledTimes(1);
      const firstWatcherCall = createWatcher.mock.calls[0];
      if (firstWatcherCall === undefined) {
        throw new Error("expected watcher setup call");
      }
      const [watchPaths, watchOptions] = firstWatcherCall as unknown as [
        string[],
        { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
      ];
      expect(watchPaths).toEqual(runNodeWatchedPaths);
      expect(watchPaths).toContain("extensions");
      expect(watchPaths).toContain("tsdown.config.ts");
      expect(watchOptions.ignoreInitial).toBe(true);
      expect(watchOptions.ignored("src")).toBe(false);
      expect(watchOptions.ignored("src/infra")).toBe(false);
      expect(watchOptions.ignored("extensions")).toBe(false);
      expect(watchOptions.ignored("extensions/voice-call")).toBe(false);
      expect(watchOptions.ignored("extensions/voice-call/dist")).toBe(true);
      expect(watchOptions.ignored("extensions/voice-call/node_modules")).toBe(true);
      expect(watchOptions.ignored("extensions/voice-call/node_modules/chokidar/index.js")).toBe(
        true,
      );
      expect(watchOptions.ignored("src/infra/watch-node.test.ts")).toBe(true);
      expect(watchOptions.ignored("src/infra/watch-node.test.tsx")).toBe(true);
      expect(watchOptions.ignored("src/infra/watch-node-test-helpers.ts")).toBe(true);
      expect(watchOptions.ignored(VOICE_CALL_README)).toBe(true);
      expect(watchOptions.ignored(VOICE_CALL_MANIFEST)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_PACKAGE)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_INDEX)).toBe(false);
      expect(watchOptions.ignored(VOICE_CALL_RUNTIME)).toBe(false);
      expect(watchOptions.ignored("src/infra/watch-node.ts")).toBe(false);
      expect(watchOptions.ignored("tsconfig.json")).toBe(false);

      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnCall = requireMockCall(spawn, 0);
      expect(spawnCall[0]).toBe("/usr/local/bin/node");
      expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
      const spawnOptions = requireSpawnOptions(spawn, 0);
      expect(spawnOptions.cwd).toBe(cwd);
      expect(spawnOptions.stdio).toBe("inherit");
      const spawnEnv = requireSpawnEnv(spawn, 0);
      expect(spawnEnv.PATH).toBe("/usr/bin");
      expect(spawnEnv.OPENCLAW_WATCH_MODE).toBe("1");
      expect(spawnEnv.OPENCLAW_WATCH_SESSION).toBe("1700000000000-4242");
      expect(spawnEnv.OPENCLAW_NO_RESPAWN).toBe("1");
      expect(spawnEnv.OPENCLAW_WATCH_COMMAND).toBe("gateway --force");
      expect(spawnEnv.OPENCLAW_TRACE_SYNC_IO).toBeUndefined();
      fakeProcess.emit("SIGINT");
      const exitCode = await runPromise;
      expect(exitCode).toBe(130);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves explicit sync I/O trace overrides for gateway watch", async () => {
    const { child, spawn, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-" }, async (cwd) => {
      const runPromise = runWatch({
        args: ["gateway", "--force"],
        cwd,
        createWatcher,
        env: { OPENCLAW_TRACE_SYNC_IO: "0" },
        lockDisabled: true,
        process: fakeProcess,
        spawn,
      });

      const spawnCall = requireMockCall(spawn, 0);
      expect(spawnCall[0]).toBe("/usr/local/bin/node");
      expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
      expect(requireSpawnEnv(spawn, 0).OPENCLAW_TRACE_SYNC_IO).toBe("0");

      fakeProcess.emit("SIGINT");
      await runPromise;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("starts the runner before loading chokidar", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi.fn(() => child);
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(async () => {}),
    });
    const watch = vi.fn(() => watcher);
    let resolveLoadChokidar: (value: { watch: typeof watch }) => void = () => {};
    const loadChokidar = vi.fn(
      () =>
        new Promise<{ watch: typeof watch }>((resolve) => {
          resolveLoadChokidar = resolve;
        }),
    );
    const fakeProcess = createFakeProcess();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      loadChokidar,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(loadChokidar).toHaveBeenCalledTimes(1);
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
      loadChokidar.mock.invocationCallOrder[0],
    );

    resolveLoadChokidar({ watch });
    await new Promise((resolve) => setImmediate(resolve));
    expect(watch).toHaveBeenCalledTimes(1);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("terminates child on SIGINT and returns shell interrupt code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;

    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("terminates child on SIGTERM and returns shell terminate code", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    fakeProcess.emit("SIGTERM");
    const exitCode = await runPromise;

    expect(exitCode).toBe(143);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("returns the child exit code when the runner exits on its own", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["config", "validate"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    child.emit("exit", 0, null);
    const exitCode = await runPromise;

    expect(exitCode).toBe(0);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("runs doctor once and restarts when gateway exits nonzero", async () => {
    const gatewayA = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const doctor = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const gatewayB = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(gatewayA)
      .mockReturnValueOnce(doctor)
      .mockReturnValueOnce(gatewayB);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ spawn });

    gatewayA.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledTimes(2);
    const doctorSpawnCall = requireMockCall(spawn, 1);
    expect(doctorSpawnCall[0]).toBe("/usr/local/bin/node");
    expect(doctorSpawnCall[1]).toEqual([
      "scripts/run-node.mjs",
      "doctor",
      "--fix",
      "--non-interactive",
    ]);
    expect(requireSpawnOptions(spawn, 1).stdio).toBe("inherit");

    doctor.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledTimes(3);
    const restartedGatewaySpawnCall = requireMockCall(spawn, 2);
    expect(restartedGatewaySpawnCall[0]).toBe("/usr/local/bin/node");
    expect(restartedGatewaySpawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
    expect(requireSpawnOptions(spawn, 2).stdio).toBe("inherit");

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(gatewayB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("does not run doctor after a gateway failure when auto doctor is disabled", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    child.emit("exit", 1, null);
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("restarts when the runner exits with a SIGTERM-derived code unexpectedly", async () => {
    const childA = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
    });
    const childB = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ spawn });

    childA.emit("exit", 143, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(2);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("forces no-respawn for watch children even when supervisor hints are inherited", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      env: {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
        PATH: "/usr/bin",
      },
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    const spawnCall = requireMockCall(spawn, 0);
    expect(spawnCall[0]).toBe("/usr/local/bin/node");
    expect(spawnCall[1]).toEqual(["scripts/run-node.mjs", "gateway", "--force"]);
    const spawnEnv = requireSpawnEnv(spawn, 0);
    expect(spawnEnv.LAUNCH_JOB_LABEL).toBe("ai.openclaw.gateway");
    expect(spawnEnv.OPENCLAW_NO_RESPAWN).toBe("1");

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("ignores test-only changes and restarts on non-test source changes", async () => {
    const childA = createAutoExitChild();
    const childB = createAutoExitChild();
    const childC = createAutoExitChild();
    const childD = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB)
      .mockReturnValueOnce(childC)
      .mockReturnValueOnce(childD);
    const { watcher, fakeProcess, runPromise } = startWatchRun({ spawn });

    watcher.emit("change", "src/infra/watch-node.test.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node.test.tsx");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", "src/infra/watch-node-test-helpers.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_README);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(childA.kill).not.toHaveBeenCalled();

    watcher.emit("change", VOICE_CALL_MANIFEST);
    await new Promise((resolve) => setImmediate(resolve));
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);

    watcher.emit("change", VOICE_CALL_PACKAGE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(3);

    watcher.emit("change", "src/infra/watch-node.ts");
    await new Promise((resolve) => setImmediate(resolve));
    expect(childC.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(4);

    fakeProcess.emit("SIGINT");
    const exitCode = await runPromise;
    expect(exitCode).toBe(130);
  });

  it("kills child and exits when watcher emits an error", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();

    const runPromise = runWatch({
      args: ["gateway", "--force"],
      createWatcher,
      lockDisabled: true,
      process: fakeProcess,
      spawn,
    });

    watcher.emit("error", new Error("watch failed"));
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("prints recovery guidance when chokidar fails with invalid package config", async () => {
    const error = Object.assign(
      new Error(
        'Invalid package config /tmp/openclaw/.pnpm/chokidar/package.json while importing "chokidar" from /tmp/openclaw/scripts/watch-node.mjs.',
      ),
      { code: "ERR_INVALID_PACKAGE_CONFIG" },
    );
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi.fn(() => child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runWatch({
          args: ["gateway", "--force"],
          cwd: "/tmp/openclaw",
          loadChokidar: vi.fn(async () => {
            throw error;
          }),
          process: createFakeProcess(),
          spawn,
        }),
      ).rejects.toBe(error);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorSpy.mock.calls).toEqual([
        [""],
        [
          "[openclaw] gateway:watch could not start because a dependency package config looks corrupted.",
        ],
        ["[openclaw] Invalid package config: /tmp/openclaw/.pnpm/chokidar/package.json"],
        ["[openclaw] This usually means a file in node_modules is empty or truncated."],
        ["[openclaw] Recommended recovery:"],
        ["[openclaw]   rm -rf node_modules"],
        ["[openclaw]   pnpm store prune"],
        ["[openclaw]   pnpm install"],
        [""],
        ["[openclaw] Original error:"],
        [error],
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log non-package-config chokidar import errors before rethrowing", async () => {
    const error = Object.assign(new Error("Cannot find package 'chokidar'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {}),
    });
    const spawn = vi.fn(() => child);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runWatch({
          loadChokidar: vi.fn(async () => {
            throw error;
          }),
          process: createFakeProcess(),
          spawn,
        }),
      ).rejects.toBe(error);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("replaces an existing watcher lock holder before starting", async () => {
    const { child, spawn, watcher, createWatcher, fakeProcess } = createWatchHarness();
    await withTempDir({ prefix: "openclaw-watch-node-lock-" }, async (cwd) => {
      const lockPath = resolveTestWatchLockPath(cwd, ["gateway", "--force"]);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: 2121,
          command: "gateway --force",
          createdAt: new Date(1_700_000_000_000).toISOString(),
          cwd,
          watchSession: "existing-session",
        })}\n`,
        "utf8",
      );

      let existingWatcherAlive = true;
      const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) {
          if (pid === 2121 && existingWatcherAlive) {
            return;
          }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        if (pid === 2121 && signal === "SIGTERM") {
          existingWatcherAlive = false;
          return;
        }
        throw new Error(`unexpected signal ${signal} for pid ${pid}`);
      });

      const runPromise = runWatch({
        args: ["gateway", "--force"],
        createWatcher,
        cwd,
        now: () => 1_700_000_000_000,
        process: fakeProcess,
        signalProcess,
        sleep: async () => {},
        spawn,
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(signalProcess).toHaveBeenCalledWith(2121, "SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(1);
      const lockRecord = requireRecord(JSON.parse(fs.readFileSync(lockPath, "utf8")), "watch lock");
      expect(lockRecord.pid).toBe(4242);
      expect(lockRecord.command).toBe("gateway --force");
      expect(lockRecord.watchSession).toBe("1700000000000-4242");

      fakeProcess.emit("SIGINT");
      const exitCode = await runPromise;

      expect(exitCode).toBe(130);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(watcher.close).toHaveBeenCalledTimes(1);
    });
  });
});
