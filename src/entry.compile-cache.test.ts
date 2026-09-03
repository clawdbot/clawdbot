// Tests compile-cache child-process spawning and environment propagation.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined, readStringValue } from "@openclaw/normalization-core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { mockNodeBuiltinModule } from "./plugin-sdk/test-helpers/node-builtin-mocks.js";
import { createDeferredCore } from "./shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "./test-utils/env.js";
import { withMockedPlatform } from "./test-utils/vitest-spies.js";

type Spawn = (...args: Parameters<typeof import("node:child_process").spawn>) => ChildProcess;

const { enableCompileCache, getCompileCacheDir, spawn, attachChildProcessBridge } = vi.hoisted(
  () => ({
    enableCompileCache: vi.fn<typeof import("node:module").enableCompileCache>(),
    getCompileCacheDir: vi.fn<() => string | undefined>(),
    spawn: vi.fn<Spawn>(),
    attachChildProcessBridge:
      vi.fn<typeof import("./process/child-process-bridge.js").attachChildProcessBridge>(),
  }),
);

// Node's enabled cache survives subsequent calls in the same instance. Observe the
// API boundary without enabling a real cache in the shared Vitest worker.
vi.mock("node:module", async (importOriginal) =>
  mockNodeBuiltinModule(() => importOriginal<typeof import("node:module")>(), {
    enableCompileCache,
    getCompileCacheDir,
  }),
);
vi.mock("node:child_process", async (importOriginal) =>
  // The fixture covers the three-argument spawn call used with inherited stdio.
  mockNodeBuiltinModule<{ spawn: Spawn }>(
    () => importOriginal<typeof import("node:child_process")>(),
    { spawn },
  ),
);
vi.mock("./process/child-process-bridge.js", () => ({ attachChildProcessBridge }));

import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";

function enabledDirectory(callIndex = 0): string {
  const [directory] = expectDefined(enableCompileCache.mock.calls[callIndex], "cache enable call");
  return expectDefined(readStringValue(directory), "cache directory string");
}

describe("entry compile cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let entryFile: string;
  let argv: string[];
  let child: ChildProcess;
  let kill: Mock<ChildProcess["kill"]>;
  let exit: MockInstance<typeof process.exit>;
  let writeStderr: MockInstance<typeof process.stderr.write>;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    root = tempDirs.make("openclaw-compile-cache-");
    entryFile = path.join(root, "dist", "entry.js");
    argv = [process.execPath, entryFile, "status", "--json"];
    envSnapshot = captureEnv([
      "NODE_COMPILE_CACHE",
      "NODE_DISABLE_COMPILE_CACHE",
      "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
      "OPENCLAW_PROFILE",
    ]);
    setTestEnvValue("NODE_COMPILE_CACHE", path.join(root, ".node-cache"));
    deleteTestEnvValue("NODE_DISABLE_COMPILE_CACHE");
    deleteTestEnvValue("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED");
    enableCompileCache.mockReset();
    getCompileCacheDir.mockReset();
    attachChildProcessBridge.mockReset();
    child = new EventEmitter() as ChildProcess;
    kill = vi.fn(() => true);
    child.kill = kill;
    spawn.mockReset().mockReturnValue(child);
    vi.spyOn(process, "argv", "get").mockImplementation(() => argv);
    vi.spyOn(process, "execArgv", "get").mockReturnValue(["--no-warnings"]);
    exit = vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
    writeStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
  });

  async function markSourceCheckout() {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "entry.ts"), "export {};\n", "utf8");
  }

  it("resolves install roots from source and dist entry paths", () => {
    expect(resolveEntryInstallRoot("/repo/openclaw/src/entry.ts")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/repo/openclaw/dist/entry.js")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/pkg/openclaw/entry.js")).toBe("/pkg/openclaw");
  });

  it("treats git and source entry markers as source checkouts", async () => {
    await fs.writeFile(path.join(root, ".git"), "gitdir: .git/worktrees/openclaw\n", "utf8");
    enableOpenClawCompileCache({ env: {}, installRoot: root });
    expect(enableCompileCache).not.toHaveBeenCalled();
  });

  it("disables compile cache for source-checkout installs", async () => {
    await markSourceCheckout();
    enableOpenClawCompileCache({ env: {}, installRoot: root });
    expect(enableCompileCache).not.toHaveBeenCalled();
  });

  it("keeps compile cache enabled for packaged installs unless disabled by env", () => {
    enableOpenClawCompileCache({ env: {}, installRoot: root });
    expect(enableCompileCache).toHaveBeenCalledOnce();
    enableOpenClawCompileCache({ env: { NODE_DISABLE_COMPILE_CACHE: "1" }, installRoot: root });
    expect(enableCompileCache).toHaveBeenCalledOnce();
  });

  it("scopes packaged compile cache by package install metadata", async () => {
    await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.4.29"}\n', "utf8");
    enableOpenClawCompileCache({
      env: { NODE_COMPILE_CACHE: path.join(root, ".node-cache") },
      installRoot: root,
    });
    const directory = enabledDirectory();
    expect(directory).toContain(path.join(".node-cache", "openclaw"));
    expect(directory).toContain("2026.4.29");
    expect(path.basename(directory)).toMatch(/^\d+-\d+$/);
  });

  it("invalidates a replaced installation without deleting shared compile caches", async () => {
    const packageJsonPath = path.join(root, "package.json");
    const env = { NODE_COMPILE_CACHE: path.join(root, ".node-cache") };
    await fs.writeFile(packageJsonPath, '{"version":"2026.4.29"}\n', "utf8");
    enableOpenClawCompileCache({ env, installRoot: root });
    const originalDirectory = enabledDirectory();
    await fs.mkdir(originalDirectory, { recursive: true });
    const originalCacheEntry = path.join(originalDirectory, "keep.txt");
    await fs.writeFile(originalCacheEntry, "previous cached installation\n", "utf8");
    await fs.writeFile(
      packageJsonPath,
      '{"version":"2026.4.29","installation":"replacement"}\n',
      "utf8",
    );
    enableOpenClawCompileCache({ env, installRoot: root });
    const replacementDirectory = enabledDirectory(1);
    expect(replacementDirectory).toContain(path.join("openclaw", "2026.4.29"));
    expect(replacementDirectory).not.toBe(originalDirectory);
    await expect(fs.readFile(originalCacheEntry, "utf8")).resolves.toBe(
      "previous cached installation\n",
    );
  });

  it("runs a one-shot no-cache respawn when source checkout inherits NODE_COMPILE_CACHE", async () => {
    await markSourceCheckout();
    await expect(
      respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
    ).resolves.toBe(true);
    const [command, args, options] = expectDefined(spawn.mock.calls[0], "respawn call");
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["--no-warnings", entryFile, "status", "--json"]);
    expect(options?.env?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(options?.env?.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED).toBe("1");
    expect(options?.env?.NODE_COMPILE_CACHE).toBeUndefined();
    expect(options?.stdio).toBe("inherit");
    expect(options?.detached).toBe(
      process.platform !== "win32" && !(process.stdin.isTTY || process.stdout.isTTY),
    );
  });

  it("keeps POSIX native hook relays on the timeout-owned process", async () => {
    await markSourceCheckout();
    entryFile = path.join(root, "src", "entry.ts");
    argv = [process.execPath, entryFile, "hooks", "relay", "--relay-id", "relay-1"];
    await withMockedPlatform("linux", async () => {
      await expect(
        respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
      ).resolves.toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });
    await withMockedPlatform("win32", async () => {
      await expect(
        respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
      ).resolves.toBe(true);
      expect(spawn).toHaveBeenCalledOnce();
    });
  });

  it.each(["linux", "win32"] as const)(
    "keeps foreground Gmail cleanup in process with inherited compile cache on %s",
    async (platform) => {
      await markSourceCheckout();
      entryFile = path.join(root, "src", "entry.ts");
      argv = [process.execPath, entryFile, "webhooks", "--profile", "fixture", "gmail", "run"];
      await withMockedPlatform(platform, async () => {
        await expect(
          respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
        ).resolves.toBe(false);
        expect(spawn).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps interactive no-cache respawns attached to the terminal", async () => {
    await markSourceCheckout();
    argv = [process.execPath, entryFile, "tui"];
    await respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root });
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.detached).toBe(false);
  });

  it("keeps bare-root no-cache respawns attached to the terminal", async () => {
    await markSourceCheckout();
    argv = [process.execPath, entryFile];
    await respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root });
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.detached).toBe(false);
  });

  it("does not respawn packaged installs when NODE_COMPILE_CACHE is configured", async () => {
    await expect(
      respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not respawn source checkouts twice", async () => {
    await markSourceCheckout();
    setTestEnvValue("OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED", "1");
    await expect(
      respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs compile-cache respawns with the child-process bridge", async () => {
    await markSourceCheckout();
    await respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root });
    expect(attachChildProcessBridge).toHaveBeenCalledWith(child, {
      onSignal: expect.any(Function),
    });
    child.emit("exit", 0, null);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it("marks signal-terminated compile-cache respawn children as failed without forcing another exit", async () => {
    await markSourceCheckout();
    await respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root });
    child.emit("exit", null, "SIGTERM");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("waits for a signaled compile-cache respawn child after force-killing it", async () => {
    await markSourceCheckout();
    argv = [process.execPath, entryFile, "tui"];
    vi.useFakeTimers();
    try {
      await respawnWithoutOpenClawCompileCacheIfNeeded({
        currentFile: entryFile,
        installRoot: root,
      });
      const [, options] = expectDefined(attachChildProcessBridge.mock.calls[0], "bridge call");
      expectDefined(options?.onSignal, "signal handler")("SIGTERM");
      vi.advanceTimersByTime(1_000);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(kill).toHaveBeenCalledWith(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      expect(exit).not.toHaveBeenCalled();
      child.emit("exit", null, "SIGKILL");
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respawns when Node already enabled its cache without an inherited cache path", async () => {
    await markSourceCheckout();
    deleteTestEnvValue("NODE_COMPILE_CACHE");
    getCompileCacheDir.mockReturnValue(path.join(root, ".active-cache"));
    await expect(
      respawnWithoutOpenClawCompileCacheIfNeeded({ currentFile: entryFile, installRoot: root }),
    ).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(
      expectDefined(spawn.mock.calls[0], "respawn call")[2]?.env?.NODE_DISABLE_COMPILE_CACHE,
    ).toBe("1");
  });

  it("awaits diagnostic setup while preserving the child environment snapshot", async () => {
    await markSourceCheckout();
    setTestEnvValue("OPENCLAW_PROFILE", "before-diagnostics");
    const writer = createDeferredCore<(message: string) => void>();
    const writeError = vi.fn();
    const prepareWriteError = vi.fn(() => writer.promise);
    const pending = respawnWithoutOpenClawCompileCacheIfNeeded({
      currentFile: entryFile,
      installRoot: root,
      prepareWriteError,
    });
    try {
      expect(prepareWriteError).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      setTestEnvValue("OPENCLAW_PROFILE", "after-diagnostics");
    } finally {
      writer.resolve(writeError);
      await pending;
    }
    await expect(pending).resolves.toBe(true);
    expect(expectDefined(spawn.mock.calls[0], "respawn call")[2]?.env?.OPENCLAW_PROFILE).toBe(
      "before-diagnostics",
    );
    child.emit("error", new Error("spawn failed"));
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Failed to respawn CLI without compile cache: Error: spawn failed"),
    );
    expect(writeStderr).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
