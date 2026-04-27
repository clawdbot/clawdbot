#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRestartRelevantRunNodePath, runNodeWatchedPaths } from "./run-node.mjs";

const WATCH_NODE_RUNNER = "scripts/run-node.mjs";
const WATCH_RESTART_SIGNAL = "SIGTERM";
const WATCH_RESTARTABLE_CHILD_EXIT_CODES = new Set([143]);
const WATCH_RESTARTABLE_CHILD_SIGNALS = new Set(["SIGTERM"]);
const WATCH_IGNORED_PATH_SEGMENTS = new Set([".git", "dist", "node_modules"]);
const WATCH_LOCK_WAIT_MS = 5_000;
const WATCH_LOCK_POLL_MS = 100;
const WATCH_LOCK_DIR = path.join(".local", "watch-node");

const buildRunnerArgs = (args) => [WATCH_NODE_RUNNER, ...args];

const normalizePath = (filePath) =>
  String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");

const resolveRepoPath = (filePath, cwd) => {
  const rawPath = String(filePath ?? "");
  if (path.isAbsolute(rawPath)) {
    return normalizePath(path.relative(cwd, rawPath));
  }
  return normalizePath(rawPath);
};

const hasIgnoredPathSegment = (repoPath) =>
  normalizePath(repoPath)
    .split("/")
    .some((segment) => WATCH_IGNORED_PATH_SEGMENTS.has(segment));

const looksLikeDirectoryPath = (repoPath) => path.posix.extname(normalizePath(repoPath)) === "";

const isDirectoryLikeWatchedPath = (repoPath, watchPaths) => {
  const normalizedRepoPath = normalizePath(repoPath).replace(/\/$/, "");
  return watchPaths.some((watchPath) => {
    const normalizedWatchPath = normalizePath(watchPath).replace(/\/$/, "");
    if (!normalizedWatchPath) {
      return false;
    }
    return (
      normalizedRepoPath === normalizedWatchPath ||
      normalizedRepoPath.startsWith(`${normalizedWatchPath}/`)
    );
  });
};

const isIgnoredWatchPath = (filePath, cwd, watchPaths, stats) => {
  const repoPath = resolveRepoPath(filePath, cwd);
  if (hasIgnoredPathSegment(repoPath)) {
    return true;
  }
  if (isDirectoryLikeWatchedPath(repoPath, watchPaths)) {
    if (stats?.isDirectory?.() || looksLikeDirectoryPath(repoPath)) {
      return false;
    }
  }
  return !isRestartRelevantRunNodePath(repoPath);
};

const shouldRestartAfterChildExit = (exitCode, exitSignal) =>
  (typeof exitCode === "number" && WATCH_RESTARTABLE_CHILD_EXIT_CODES.has(exitCode)) ||
  (typeof exitSignal === "string" && WATCH_RESTARTABLE_CHILD_SIGNALS.has(exitSignal));

const isProcessAlive = (pid, signalProcess) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    signalProcess(pid, 0);
  } catch {
    return false;
  }
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createWatchLockKey = (cwd, args) =>
  createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12);

export const resolveWatchLockPath = (cwd, args = []) =>
  path.join(cwd, WATCH_LOCK_DIR, `${createWatchLockKey(cwd, args)}.json`);

const readWatchLock = (lockPath) => {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
};

const removeWatchLock = (lockPath) => {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
};

const writeWatchLock = (lockPath, payload) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
};

const logWatcher = (message, deps) => {
  deps.process.stderr?.write?.(`[openclaw] ${message}\n`);
};

const isInvalidPackageConfigError = (err) => err?.code === "ERR_INVALID_PACKAGE_CONFIG";

const extractInvalidPackageConfigPath = (err) => {
  const message = String(err?.message ?? "");
  const match = message.match(/Invalid package config (.+?) while importing /);
  return match?.[1] ?? null;
};

const printFriendlyWatchStartupError = (err) => {
  const packageConfigPath = extractInvalidPackageConfigPath(err);

  console.error("");
  console.error(
    "[openclaw] gateway:watch could not start because a dependency package config looks corrupted.",
  );
  if (packageConfigPath) {
    console.error(`[openclaw] Invalid package config: ${packageConfigPath}`);
  }
  console.error("[openclaw] This usually means a file in node_modules is empty or truncated.");
  console.error("[openclaw] Recommended recovery:");
  console.error("[openclaw]   rm -rf node_modules");
  console.error("[openclaw]   pnpm store prune");
  console.error("[openclaw]   pnpm install");
  console.error("");
  console.error("[openclaw] Original error:");
  console.error(err);
};

const loadChokidar = async () => {
  const mod = await import("chokidar");
  return mod.default ?? mod;
};

const waitForWatcherRelease = async (lockPath, pid, deps) => {
  const deadline = deps.now() + WATCH_LOCK_WAIT_MS;
  while (deps.now() < deadline) {
    if (!isProcessAlive(pid, deps.signalProcess)) {
      return true;
    }
    if (!fs.existsSync(lockPath)) {
      return true;
    }
    await deps.sleep(WATCH_LOCK_POLL_MS);
  }
  return !isProcessAlive(pid, deps.signalProcess);
};

const acquireWatchLock = async (deps, watchSession) => {
  const lockPath = resolveWatchLockPath(deps.cwd, deps.args);
  const payload = {
    pid: deps.process.pid,
    command: deps.args.join(" "),
    createdAt: new Date(deps.now()).toISOString(),
    cwd: deps.cwd,
    watchSession,
  };

  while (true) {
    try {
      writeWatchLock(lockPath, payload);
      return { lockPath, pid: deps.process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existing = readWatchLock(lockPath);
    const existingPid = existing?.pid;
    if (!isProcessAlive(existingPid, deps.signalProcess)) {
      removeWatchLock(lockPath);
      continue;
    }

    logWatcher(`Replacing existing watcher pid ${existingPid}.`, deps);
    try {
      deps.signalProcess(existingPid, WATCH_RESTART_SIGNAL);
    } catch (error) {
      if (isProcessAlive(existingPid, deps.signalProcess)) {
        logWatcher(
          `Failed to stop existing watcher pid ${existingPid}: ${error?.message ?? "unknown error"}`,
          deps,
        );
        return null;
      }
    }

    const released = await waitForWatcherRelease(lockPath, existingPid, deps);
    if (!released) {
      logWatcher(`Timed out waiting for watcher pid ${existingPid} to exit.`, deps);
      return null;
    }
    removeWatchLock(lockPath);
  }
};

const releaseWatchLock = (lockHandle) => {
  if (!lockHandle) {
    return;
  }
  const current = readWatchLock(lockHandle.lockPath);
  if (current?.pid === lockHandle.pid) {
    removeWatchLock(lockHandle.lockPath);
  }
};

/**
 * @param {{
 *   spawn?: typeof spawn;
 *   process?: NodeJS.Process;
 *   cwd?: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   now?: () => number;
 *   sleep?: (ms: number) => Promise<void>;
 *   signalProcess?: (pid: number, signal: string | number) => void;
 *   lockDisabled?: boolean;
 *   createWatcher?: (
 *     watchPaths: string[],
 *     options: { ignoreInitial: boolean; ignored: (watchPath: string) => boolean },
 *   ) => { on: (event: string, cb: (...args: unknown[]) => void) => void; close?: () => Promise<void> };
 *   watchPaths?: string[];
 * }} [params]
 */
export async function runWatchMain(params = {}) {
  let createWatcher = params.createWatcher;
  if (!createWatcher) {
    try {
      const chokidarModule = await (params.loadChokidar ?? loadChokidar)();
      createWatcher = (watchPaths, options) => chokidarModule.watch(watchPaths, options);
    } catch (err) {
      if (isInvalidPackageConfigError(err)) {
        printFriendlyWatchStartupError(err);
      }
      throw err;
    }
  }

  const deps = {
    spawn: params.spawn ?? spawn,
    process: params.process ?? process,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    now: params.now ?? Date.now,
    sleep: params.sleep ?? sleep,
    signalProcess: params.signalProcess ?? ((pid, signal) => process.kill(pid, signal)),
    lockDisabled: params.lockDisabled === true,
    createWatcher,
    watchPaths: params.watchPaths ?? runNodeWatchedPaths,
  };

  const childEnv = { ...deps.env };
  const watchSession = `${deps.now()}-${deps.process.pid}`;
  childEnv.OPENCLAW_WATCH_MODE = "1";
  childEnv.OPENCLAW_WATCH_SESSION = watchSession;
  // The watcher owns process restarts; keep SIGUSR1/config reloads in-process
  // so inherited launchd/systemd markers do not make the child exit and stall.
  childEnv.OPENCLAW_NO_RESPAWN = "1";
  if (deps.args.length > 0) {
    childEnv.OPENCLAW_WATCH_COMMAND = deps.args.join(" ");
  }

  return await new Promise((resolve) => {
    let settled = false;
    let shuttingDown = false;
    let restartRequested = false;
    let watchProcess = null;
    let lockHandle = null;
    let onSigInt;
    let onSigTerm;

    const watcher = deps.createWatcher(deps.watchPaths, {
      ignoreInitial: true,
      ignored: (watchPath, stats) =>
        isIgnoredWatchPath(watchPath, deps.cwd, deps.watchPaths, stats),
    });

    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      releaseWatchLock(lockHandle);
      watcher.close?.().catch?.(() => {});
      resolve(code);
    };

    const startRunner = () => {
      watchProcess = deps.spawn(deps.process.execPath, buildRunnerArgs(deps.args), {
        cwd: deps.cwd,
        env: childEnv,
        stdio: "inherit",
      });
      watchProcess.on("error", (error) => {
        watchProcess = null;
        logWatcher(`Failed to spawn watcher child: ${error?.message ?? "unknown error"}`, deps);
        settle(1);
      });
      watchProcess.on("exit", (exitCode, exitSignal) => {
        watchProcess = null;
        if (shuttingDown) {
          return;
        }
        if (restartRequested || shouldRestartAfterChildExit(exitCode, exitSignal)) {
          restartRequested = false;
          startRunner();
          return;
        }
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const requestRestart = (changedPath) => {
      if (shuttingDown || isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths)) {
        return;
      }
      if (!watchProcess) {
        startRunner();
        return;
      }
      restartRequested = true;
      if (typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
    };

    watcher.on("add", requestRestart);
    watcher.on("change", requestRestart);
    watcher.on("unlink", requestRestart);
    watcher.on("error", () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(1);
    });

    onSigInt = () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(130);
    };
    onSigTerm = () => {
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        watchProcess.kill(WATCH_RESTART_SIGNAL);
      }
      settle(143);
    };

    deps.process.on("SIGINT", onSigInt);
    deps.process.on("SIGTERM", onSigTerm);

    if (deps.lockDisabled) {
      lockHandle = { lockPath: "", pid: deps.process.pid };
      startRunner();
      return;
    }

    void acquireWatchLock(deps, watchSession)
      .then((handle) => {
        if (!handle) {
          settle(1);
          return;
        }
        lockHandle = handle;
        startRunner();
      })
      .catch((error) => {
        logWatcher(`Failed to acquire watcher lock: ${error?.message ?? "unknown error"}`, deps);
        settle(1);
      });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runWatchMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (!isInvalidPackageConfigError(err)) {
        console.error(err);
      }
      process.exit(1);
    });
}
