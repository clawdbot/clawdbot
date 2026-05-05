import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import os from "node:os";
import path from "node:path";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

const COMPILE_CACHE_RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
const COMPILE_CACHE_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;

export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  const entryParent = path.basename(entryDir);
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

export function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return (
    existsSync(path.join(installRoot, ".git")) ||
    existsSync(path.join(installRoot, "src", "entry.ts"))
  );
}

function isNodeCompileCacheDisabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_DISABLE_COMPILE_CACHE !== undefined;
}

function isNodeCompileCacheRequested(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_COMPILE_CACHE !== undefined && !isNodeCompileCacheDisabled(env);
}

export function shouldEnableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): boolean {
  if (isNodeCompileCacheDisabled(params.env)) {
    return false;
  }
  return !isSourceCheckoutInstallRoot(params.installRoot);
}

function sanitizeCompileCachePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function readPackageVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof parsed.version === "string" &&
      parsed.version.trim().length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through to an install-metadata-only cache key.
  }
  return "unknown";
}

export function resolveOpenClawCompileCacheDirectory(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): string {
  const env = params.env ?? process.env;
  const packageJsonPath = path.join(params.installRoot, "package.json");
  const version = sanitizeCompileCachePathSegment(readPackageVersion(packageJsonPath));
  let installMarker = "no-package-json";
  try {
    const stat = statSync(packageJsonPath);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package archives should always have package.json, but keep startup best-effort.
  }
  const baseDirectory =
    env.NODE_COMPILE_CACHE && !isNodeCompileCacheDisabled(env)
      ? env.NODE_COMPILE_CACHE
      : path.join(os.tmpdir(), "node-compile-cache");
  return path.join(
    baseDirectory,
    "openclaw",
    version,
    sanitizeCompileCachePathSegment(installMarker),
  );
}

export type OpenClawCompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

type OpenClawCompileCacheRespawnRuntime = {
  spawn: typeof spawn;
  attachChildProcessBridge: typeof attachChildProcessBridge;
  exit: (code?: number) => never;
  writeError: (message: string) => void;
};

export function buildOpenClawCompileCacheRespawnPlan(params: {
  currentFile: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  execPath?: string;
  installRoot: string;
  argv?: string[];
  compileCacheDir?: string;
}): OpenClawCompileCacheRespawnPlan | undefined {
  const env = params.env ?? process.env;
  if (!isSourceCheckoutInstallRoot(params.installRoot)) {
    return undefined;
  }
  if (env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") {
    return undefined;
  }
  if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) {
    return undefined;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  return {
    command: params.execPath ?? process.execPath,
    args: [
      ...(params.execArgv ?? process.execArgv),
      params.currentFile,
      ...(params.argv ?? process.argv).slice(2),
    ],
    env: nextEnv,
  };
}

export function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  installRoot: string;
}): boolean {
  const plan = buildOpenClawCompileCacheRespawnPlan({
    currentFile: params.currentFile,
    installRoot: params.installRoot,
    compileCacheDir: getCompileCacheDir?.(),
  });
  if (!plan) {
    return false;
  }
  runOpenClawCompileCacheRespawnPlan(plan);
  return true;
}

export function runOpenClawCompileCacheRespawnPlan(
  plan: OpenClawCompileCacheRespawnPlan,
  runtime: OpenClawCompileCacheRespawnRuntime = {
    spawn,
    attachChildProcessBridge,
    exit: process.exit.bind(process) as (code?: number) => never,
    writeError: (message: string) => process.stderr.write(message),
  },
): ChildProcess {
  const child = runtime.spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
  });
  // Give the child a moment to honor forwarded signals, then exit the parent so
  // a child that ignores SIGTERM cannot keep the compile-cache wrapper alive indefinitely.
  let signalExitTimer: NodeJS.Timeout | undefined;
  let signalForceKillTimer: NodeJS.Timeout | undefined;
  const clearSignalExitTimer = (): void => {
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = undefined;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = undefined;
    }
  };
  const forceKillChild = (): void => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      runtime.exit(1);
    }, COMPILE_CACHE_RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (): void => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, COMPILE_CACHE_RESPAWN_SIGNAL_EXIT_GRACE_MS);
    signalExitTimer.unref?.();
  };

  runtime.attachChildProcessBridge(child, {
    onSignal: scheduleParentExit,
  });

  child.once("exit", (code, signal) => {
    clearSignalExitTimer();
    if (signal) {
      runtime.exit(1);
    }
    runtime.exit(code ?? 1);
  });

  child.once("error", (error) => {
    clearSignalExitTimer();
    runtime.writeError(
      `[openclaw] Failed to respawn CLI without compile cache: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    runtime.exit(1);
  });

  return child;
}

export function enableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): void {
  if (!shouldEnableOpenClawCompileCache(params)) {
    return;
  }
  try {
    enableCompileCache(resolveOpenClawCompileCacheDirectory(params));
  } catch {
    // Best-effort only; never block startup.
  }
}
