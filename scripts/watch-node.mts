// Watches dev source paths and restarts scripts/run-node.mjs when relevant
// files change.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { sleep } from "./lib/sleep.mjs";
import { createRunNodePathClassifier, runNodeWatchedPaths } from "./run-node-watch-paths.mts";

const WATCH_NODE_RUNNER = "scripts/run-node.mjs";
const WATCH_RESTART_SIGNAL = "SIGTERM";
const WATCH_RESTARTABLE_CHILD_EXIT_CODES = new Set([143]);
const WATCH_RESTARTABLE_CHILD_SIGNALS = new Set(["SIGTERM"]);
const WATCH_IGNORED_PATH_SEGMENTS = new Set([".git", "dist", "node_modules"]);
const WATCH_LOCK_WAIT_MS = 5_000;
const WATCH_LOCK_POLL_MS = 100;
const WATCH_SHUTDOWN_KILL_GRACE_MS = 5_000;
const WATCH_LOCK_DIR = path.join(".local", "watch-node");
const WATCH_DIST_ENTRY_POLL_MS = 1_000;
const WATCH_DIST_ENTRY_TIMEOUT_MS = 5 * 60 * 1_000;
const AUTO_DOCTOR_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
type ProcessSignal = `SIG${string}`;
type TimerHandle = ReturnType<typeof setTimeout>;

type WatchChild = {
  pid?: number;
  kill(signal?: ProcessSignal | number): boolean | void;
  on(event: "exit", callback: (code: number | null, signal: ProcessSignal | null) => void): unknown;
  on(event: "error", callback: (error: Error) => void): unknown;
};
type WatchPathStats = { isDirectory(): boolean };
type WatchOptions = {
  ignoreInitial: boolean;
  ignored: (watchPath: string, stats?: WatchPathStats) => boolean;
};
type Watcher = {
  on(event: "add" | "change" | "unlink", callback: (path: string) => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  close?: () => { catch?(onRejected: () => void): unknown } | void;
};
type WatcherFactory = (paths: string[], options: WatchOptions) => Watcher;
type WatchPathClassifier = {
  refreshGeneratedPluginAssetPaths(): void;
  isRestartRelevantRunNodePath(repoPath: unknown): boolean;
};
type SignalProcess = (pid: number, signal: ProcessSignal | 0) => void;
type WatchMainParams = {
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      detached: boolean;
      env: NodeJS.ProcessEnv;
      stdio: "inherit";
    },
  ) => WatchChild;
  createWatcher?: WatcherFactory;
  loadChokidar?: () => Promise<{ watch: WatcherFactory }>;
  watchPaths?: string[];
  pathClassifier?: WatchPathClassifier;
  process?: NodeJS.Process;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  fs?: Pick<typeof fs, "existsSync">;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signalProcess?: SignalProcess;
  lockDisabled?: boolean;
};

type WatchDeps = Required<
  Pick<
    WatchMainParams,
    | "spawn"
    | "loadChokidar"
    | "watchPaths"
    | "pathClassifier"
    | "process"
    | "cwd"
    | "args"
    | "env"
    | "fs"
    | "now"
    | "sleep"
    | "signalProcess"
    | "lockDisabled"
  >
> & { createWatcher?: WatcherFactory };

type WatchLock = {
  pid: number;
  command: string;
  createdAt: string;
  cwd: string;
  watchSession: string;
};

const buildRunnerArgs = (args: string[]) => [WATCH_NODE_RUNNER, ...args];
const buildDoctorRunnerArgs = () => [WATCH_NODE_RUNNER, "doctor", "--fix", "--non-interactive"];

const normalizePath = (filePath: string) => filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");

const resolveRepoPath = (filePath: unknown, cwd: string) => {
  const rawPath = typeof filePath === "string" ? filePath : "";
  if (path.isAbsolute(rawPath)) {
    return normalizePath(path.relative(cwd, rawPath));
  }
  return normalizePath(rawPath);
};

const hasIgnoredPathSegment = (repoPath: string) =>
  normalizePath(repoPath)
    .split("/")
    .some((segment) => WATCH_IGNORED_PATH_SEGMENTS.has(segment));

const looksLikeDirectoryPath = (repoPath: string) =>
  path.posix.extname(normalizePath(repoPath)) === "";

const isDirectoryLikeWatchedPath = (repoPath: string, watchPaths: string[]) => {
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

const isIgnoredWatchPath = (
  filePath: unknown,
  cwd: string,
  watchPaths: string[],
  pathClassifier: WatchPathClassifier,
  stats?: WatchPathStats,
) => {
  const repoPath = resolveRepoPath(filePath, cwd);
  if (hasIgnoredPathSegment(repoPath)) {
    return true;
  }
  if (isDirectoryLikeWatchedPath(repoPath, watchPaths)) {
    if (stats?.isDirectory?.() || looksLikeDirectoryPath(repoPath)) {
      return false;
    }
  }
  return !pathClassifier.isRestartRelevantRunNodePath(repoPath);
};

const shouldRestartAfterChildExit = (exitCode: number | null, exitSignal: ProcessSignal | null) =>
  (typeof exitCode === "number" && WATCH_RESTARTABLE_CHILD_EXIT_CODES.has(exitCode)) ||
  (typeof exitSignal === "string" && WATCH_RESTARTABLE_CHILD_SIGNALS.has(exitSignal));

const isGatewayWatchCommand = (args: string[]) => args[0] === "gateway";

const shouldRunAutoDoctor = (deps: WatchDeps, autoDoctorAttempted: boolean) =>
  !autoDoctorAttempted &&
  isGatewayWatchCommand(deps.args) &&
  !AUTO_DOCTOR_DISABLE_VALUES.has(
    (deps.env.OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR ?? "").toLowerCase(),
  );

const isProcessAlive = (pid: unknown, signalProcess: SignalProcess) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    signalProcess(pid, 0);
  } catch {
    return false;
  }
  return true;
};

const createWatchLockKey = (cwd: string, args: string[]) =>
  createHash("sha256").update(cwd).update("\0").update(args.join("\0")).digest("hex").slice(0, 12);

/** Resolves the lock path that prevents duplicate watch-node loops. */
const resolveWatchLockPath = (cwd: string, args: string[] = []) =>
  path.join(cwd, WATCH_LOCK_DIR, `${createWatchLockKey(cwd, args)}.json`);

const readWatchLock = (lockPath: string): WatchLock | null => {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    return isWatchLock(value) ? value : null;
  } catch {
    return null;
  }
};

const removeWatchLock = (lockPath: string) => {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
};

const writeWatchLock = (lockPath: string, payload: WatchLock) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
};

const logWatcher = (message: string, deps: WatchDeps) => {
  deps.process.stderr?.write?.(`[openclaw] ${message}\n`);
};

const isInvalidPackageConfigError = (err: unknown) =>
  errorCode(err) === "ERR_INVALID_PACKAGE_CONFIG";

const extractInvalidPackageConfigPath = (err: unknown) => {
  const message = errorMessage(err);
  const match = message.match(/Invalid package config (.+?) while importing /);
  return match?.[1] ?? null;
};

const printFriendlyWatchStartupError = (err: unknown) => {
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

const waitForWatcherRelease = async (lockPath: string, pid: number, deps: WatchDeps) => {
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

const acquireWatchLock = async (deps: WatchDeps, watchSession: string) => {
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
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const existing = readWatchLock(lockPath);
    const existingPid = existing?.pid;
    if (typeof existingPid !== "number" || !isProcessAlive(existingPid, deps.signalProcess)) {
      removeWatchLock(lockPath);
      continue;
    }

    logWatcher(`Replacing existing watcher pid ${existingPid}.`, deps);
    try {
      deps.signalProcess(existingPid, WATCH_RESTART_SIGNAL);
    } catch (error) {
      if (isProcessAlive(existingPid, deps.signalProcess)) {
        logWatcher(
          `Failed to stop existing watcher pid ${existingPid}: ${errorMessage(error) || "unknown error"}`,
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

const releaseWatchLock = (lockHandle: { lockPath: string; pid: number } | null) => {
  if (!lockHandle) {
    return;
  }
  const current = readWatchLock(lockHandle.lockPath);
  if (current?.pid === lockHandle.pid) {
    removeWatchLock(lockHandle.lockPath);
  }
};

/**
 * Runs the watch loop and restarts the child process on relevant changes.
 */
export async function runWatchMain(params: WatchMainParams = {}): Promise<number> {
  const cwd = params.cwd ?? process.cwd();
  const deps = {
    spawn: params.spawn ?? spawn,
    process: params.process ?? process,
    cwd,
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    fs: params.fs ?? fs,
    now: params.now ?? Date.now,
    sleep: params.sleep ?? sleep,
    signalProcess:
      params.signalProcess ??
      ((pid: number, signal: ProcessSignal | 0) =>
        signal === 0 ? process.kill(pid, signal) : process.kill(pid, signal as NodeJS.Signals)),
    lockDisabled: params.lockDisabled === true,
    pathClassifier: params.pathClassifier ?? createRunNodePathClassifier({ rootDir: cwd }),
    createWatcher: params.createWatcher,
    loadChokidar: params.loadChokidar ?? loadChokidar,
    watchPaths: params.watchPaths ?? runNodeWatchedPaths,
  } satisfies WatchDeps;

  const childEnv = { ...deps.env };
  const watchSession = `${deps.now()}-${deps.process.pid}`;
  const useChildProcessGroup = process.platform !== "win32" && !deps.process.stdin?.isTTY;
  childEnv.OPENCLAW_WATCH_MODE = "1";
  childEnv.OPENCLAW_WATCH_SESSION = watchSession;
  // The watcher owns process restarts; keep SIGUSR1/config reloads in-process
  // so inherited launchd/systemd markers do not make the child exit and stall.
  childEnv.OPENCLAW_NO_RESPAWN = "1";
  if (deps.args.length > 0) {
    childEnv.OPENCLAW_WATCH_COMMAND = deps.args.join(" ");
  }

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let shuttingDown = false;
    let restartRequested = false;
    let deferredRestartGeneration = 0;
    let deferredRestartActive = false;
    let watchProcess: WatchChild | null = null;
    let watcher: Watcher | null = null;
    let lockHandle: { lockPath: string; pid: number } | null = null;
    let autoDoctorAttempted = false;
    let shutdownExitCode: number | null = null;
    let shutdownKillTimer: TimerHandle | null = null;

    const signalWatchProcess = (child: WatchChild, signal: ProcessSignal) => {
      if (!child || typeof child.kill !== "function") {
        return;
      }
      if (useChildProcessGroup && typeof child.pid === "number") {
        try {
          deps.signalProcess(-child.pid, signal);
          return;
        } catch (error) {
          if (errorCode(error) === "ESRCH" || errorCode(error) === "EPERM") {
            return;
          }
        }
      }
      child.kill(signal as NodeJS.Signals);
    };

    const forceKillWatchProcessGroup = (child: WatchChild | null) => {
      if (!useChildProcessGroup || typeof child?.pid !== "number") {
        return;
      }
      try {
        deps.signalProcess(-child.pid, "SIGKILL");
      } catch (error) {
        if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") {
          throw error;
        }
      }
    };

    const settle = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      if (shutdownKillTimer) {
        clearTimeout(shutdownKillTimer);
      }
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      releaseWatchLock(lockHandle);
      watcher?.close?.()?.catch?.(() => {});
      resolve(code);
    };

    const requestShutdown = (code: number) => {
      shuttingDown = true;
      shutdownExitCode = code;
      if (!watchProcess || typeof watchProcess.kill !== "function") {
        settle(code);
        return;
      }
      const shutdownProcess = watchProcess;
      signalWatchProcess(shutdownProcess, WATCH_RESTART_SIGNAL);
      shutdownKillTimer ??= setTimeout(() => {
        shutdownKillTimer = null;
        signalWatchProcess(shutdownProcess, "SIGKILL");
      }, WATCH_SHUTDOWN_KILL_GRACE_MS);
    };

    const settleIfShuttingDown = (exitedProcess: WatchChild | null) => {
      if (!shuttingDown || shutdownExitCode === null) {
        return false;
      }
      forceKillWatchProcessGroup(exitedProcess);
      settle(shutdownExitCode);
      return true;
    };

    const startRunner = () => {
      try {
        deps.pathClassifier.refreshGeneratedPluginAssetPaths();
      } catch (error) {
        logWatcher(
          `Failed to refresh generated asset paths: ${errorMessage(error) || "unknown error"}`,
          deps,
        );
        settle(1);
        return;
      }
      watchProcess = deps.spawn(deps.process.execPath, buildRunnerArgs(deps.args), {
        cwd: deps.cwd,
        detached: useChildProcessGroup,
        env: childEnv,
        stdio: "inherit",
      });
      watchProcess.on("error", (error) => {
        watchProcess = null;
        logWatcher(
          `Failed to spawn watcher child: ${errorMessage(error) || "unknown error"}`,
          deps,
        );
        settle(1);
      });
      watchProcess.on("exit", (exitCode, exitSignal) => {
        const exitedProcess = watchProcess;
        watchProcess = null;
        if (settled) {
          return;
        }
        if (settleIfShuttingDown(exitedProcess)) {
          return;
        }
        if (restartRequested || shouldRestartAfterChildExit(exitCode, exitSignal)) {
          forceKillWatchProcessGroup(exitedProcess);
          restartRequested = false;
          deferredRestartGeneration += 1;
          deferredRestartActive = false;
          if (!hasDistEntry()) {
            deferredRestartActive = true;
            const generation = deferredRestartGeneration;
            logWatcher("Watcher child exited mid-build; waiting for the build entry.", deps);
            deferRestartUntilDistEntryExists({
              generation,
              targetProcess: null,
              onReady: () => {
                if (!watchProcess) {
                  startRunner();
                }
              },
              onTimeout: () => {
                logWatcher("Build entry wait timed out; starting run-node recovery.", deps);
                if (!watchProcess) {
                  startRunner();
                }
              },
            });
            return;
          }
          startRunner();
          return;
        }
        if (shouldRunAutoDoctor(deps, autoDoctorAttempted)) {
          runAutoDoctorAndRestart();
          return;
        }
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const handleWatcherError = () => {
      requestShutdown(1);
    };

    const rejectWatcherStartupError = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      shuttingDown = true;
      if (watchProcess && typeof watchProcess.kill === "function") {
        signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
      }
      releaseWatchLock(lockHandle);
      watcher?.close?.()?.catch?.(() => {});
      if (onSigInt) {
        deps.process.off("SIGINT", onSigInt);
      }
      if (onSigTerm) {
        deps.process.off("SIGTERM", onSigTerm);
      }
      reject(toLintErrorObject(err, "Non-Error rejection"));
    };

    const resolveCreateWatcher = async () => {
      try {
        const chokidarModule = await deps.loadChokidar();
        return (watchPaths: string[], options: WatchOptions) =>
          chokidarModule.watch(watchPaths, options);
      } catch (err) {
        if (isInvalidPackageConfigError(err)) {
          printFriendlyWatchStartupError(err);
        }
        throw err;
      }
    };

    const runAutoDoctorAndRestart = () => {
      autoDoctorAttempted = true;
      logWatcher(
        "Gateway exited early; running `openclaw doctor --fix --non-interactive` once.",
        deps,
      );
      watchProcess = deps.spawn(deps.process.execPath, buildDoctorRunnerArgs(), {
        cwd: deps.cwd,
        detached: useChildProcessGroup,
        env: {
          ...childEnv,
        },
        stdio: "inherit",
      });
      watchProcess.on("error", (error) => {
        watchProcess = null;
        logWatcher(
          `Failed to spawn doctor repair: ${errorMessage(error) || "unknown error"}`,
          deps,
        );
        settle(1);
      });
      watchProcess.on("exit", (exitCode, exitSignal) => {
        const exitedProcess = watchProcess;
        watchProcess = null;
        if (settled) {
          return;
        }
        if (settleIfShuttingDown(exitedProcess)) {
          return;
        }
        if (exitCode === 0 && !exitSignal) {
          logWatcher("Doctor repair completed; restarting gateway watch child.", deps);
          startRunner();
          return;
        }
        logWatcher(
          `Doctor repair failed; gateway:watch exiting with code ${exitSignal ? 1 : (exitCode ?? 1)}.`,
          deps,
        );
        settle(exitSignal ? 1 : (exitCode ?? 1));
      });
    };

    const hasDistEntry = () => deps.fs.existsSync(path.join(deps.cwd, "dist", "entry.js"));

    const deferRestartUntilDistEntryExists = ({
      generation,
      targetProcess,
      onReady,
      onTimeout,
    }: {
      generation: number;
      targetProcess: WatchChild | null;
      onReady: () => void;
      onTimeout: () => void;
    }) => {
      void (async () => {
        const deadline = deps.now() + WATCH_DIST_ENTRY_TIMEOUT_MS;
        while (true) {
          if (
            generation !== deferredRestartGeneration ||
            settled ||
            shuttingDown ||
            (targetProcess && (!restartRequested || watchProcess !== targetProcess))
          ) {
            return;
          }
          await deps.sleep(WATCH_DIST_ENTRY_POLL_MS);
          if (
            generation !== deferredRestartGeneration ||
            settled ||
            shuttingDown ||
            (targetProcess && (!restartRequested || watchProcess !== targetProcess))
          ) {
            return;
          }
          if (hasDistEntry()) {
            deferredRestartActive = false;
            onReady();
            return;
          }
          if (deps.now() >= deadline) {
            deferredRestartActive = false;
            onTimeout();
            return;
          }
        }
      })();
    };

    const requestRestart = (changedPath: string) => {
      if (
        shuttingDown ||
        isIgnoredWatchPath(changedPath, deps.cwd, deps.watchPaths, deps.pathClassifier)
      ) {
        return;
      }
      if (!watchProcess) {
        if (deferredRestartActive) {
          return;
        }
        startRunner();
        return;
      }
      restartRequested = true;

      // A separate build can temporarily remove dist while this healthy child is
      // still serving. Keep it alive until run-node can take ownership safely.
      if (!hasDistEntry()) {
        if (!deferredRestartActive) {
          deferredRestartActive = true;
          deferredRestartGeneration += 1;
          logWatcher("Build entry missing; keeping watcher child alive until it returns.", deps);
          const targetProcess = watchProcess;
          deferRestartUntilDistEntryExists({
            generation: deferredRestartGeneration,
            targetProcess,
            onReady: () => {
              logWatcher("Build entry restored; restarting watcher child.", deps);
              signalWatchProcess(targetProcess, WATCH_RESTART_SIGNAL);
            },
            onTimeout: () => {
              restartRequested = false;
              logWatcher("Build entry wait timed out; keeping the healthy watcher child.", deps);
            },
          });
        }
        return;
      }

      if (typeof watchProcess.kill === "function") {
        signalWatchProcess(watchProcess, WATCH_RESTART_SIGNAL);
      }
    };

    const attachWatcher = (createWatcher: WatcherFactory) => {
      if (settled) {
        return;
      }
      watcher = createWatcher(deps.watchPaths, {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          isIgnoredWatchPath(watchPath, deps.cwd, deps.watchPaths, deps.pathClassifier, stats),
      });
      watcher.on("add", requestRestart);
      watcher.on("change", requestRestart);
      watcher.on("unlink", requestRestart);
      watcher.on("error", handleWatcherError);
    };

    const startWatcher = () => {
      if (deps.createWatcher) {
        attachWatcher(deps.createWatcher);
        return;
      }
      void resolveCreateWatcher().then(attachWatcher).catch(rejectWatcherStartupError);
    };

    const onSigInt = () => {
      requestShutdown(130);
    };
    const onSigTerm = () => {
      requestShutdown(143);
    };

    deps.process.on("SIGINT", onSigInt);
    deps.process.on("SIGTERM", onSigTerm);

    if (deps.lockDisabled) {
      lockHandle = { lockPath: "", pid: deps.process.pid };
      startRunner();
      startWatcher();
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
        startWatcher();
      })
      .catch((error: unknown) => {
        logWatcher(
          `Failed to acquire watcher lock: ${errorMessage(error) || "unknown error"}`,
          deps,
        );
        settle(1);
      });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runWatchMain()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (!isInvalidPackageConfigError(err)) {
        console.error(err);
      }
      process.exit(1);
    });
}

function toLintErrorObject(value: unknown, fallbackMessage: string) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "";
  }
  return typeof error.message === "string" ? error.message : "";
}

function isWatchLock(value: unknown): value is WatchLock {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "command" in value &&
    typeof value.command === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "watchSession" in value &&
    typeof value.watchSession === "string"
  );
}
