// Manages compile-cache respawn behavior for the CLI entrypoint.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  isTerminalInteractiveRespawnArgv,
  shouldKeepNativeHookRelayInProcess,
} from "./cli/respawn-policy.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";
import {
  runRespawnChildWithSignalBridge,
  type RespawnChildRuntime,
} from "./process/respawn-child-runner.js";

const COMPILE_CACHE_DISABLED_RESPAWNED_ENV = "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED";

export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  const entryParent = path.basename(entryDir);
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

function isSourceCheckoutInstallRoot(installRoot: string): boolean {
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

function shouldEnableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): boolean {
  return (
    !isNodeCompileCacheDisabled(params.env) && !isSourceCheckoutInstallRoot(params.installRoot)
  );
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

function resolveOpenClawCompileCacheDirectory(params: {
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

type OpenClawCompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree: boolean;
};

type OpenClawCompileCacheRespawnRuntime = RespawnChildRuntime & {
  writeError: (message: string) => void;
};

function buildOpenClawCompileCacheRespawnPlan(params: {
  currentFile: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  execPath?: string;
  installRoot: string;
  argv?: string[];
  compileCacheDir?: string;
  platform?: NodeJS.Platform;
}): OpenClawCompileCacheRespawnPlan | undefined {
  const env = params.env ?? process.env;
  const argv = params.argv ?? process.argv;
  const platform = params.platform ?? process.platform;
  if (shouldKeepNativeHookRelayInProcess(argv, platform)) {
    return undefined;
  }
  if (!isSourceCheckoutInstallRoot(params.installRoot)) {
    return undefined;
  }
  if (env[COMPILE_CACHE_DISABLED_RESPAWNED_ENV] === "1") {
    return undefined;
  }
  if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) {
    return undefined;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    [COMPILE_CACHE_DISABLED_RESPAWNED_ENV]: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  return {
    command: params.execPath ?? process.execPath,
    args: [...(params.execArgv ?? process.execArgv), params.currentFile, ...argv.slice(2)],
    env: nextEnv,
    detachForProcessTree: platform !== "win32" && !isTerminalInteractiveRespawnArgv(argv),
  };
}

export async function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  installRoot: string;
  prepareWriteError?: () => Promise<(message: string) => void>;
}): Promise<boolean> {
  const plan = buildOpenClawCompileCacheRespawnPlan({
    currentFile: params.currentFile,
    installRoot: params.installRoot,
    compileCacheDir: getCompileCacheDir?.(),
  });
  if (!plan) {
    return false;
  }
  const writeError = await params.prepareWriteError?.();
  runOpenClawCompileCacheRespawnPlan(
    plan,
    writeError
      ? {
          spawn,
          attachChildProcessBridge,
          exit: process.exit.bind(process) as (code?: number) => never,
          writeError,
        }
      : undefined,
  );
  return true;
}

function runOpenClawCompileCacheRespawnPlan(
  plan: OpenClawCompileCacheRespawnPlan,
  runtime: OpenClawCompileCacheRespawnRuntime = {
    spawn,
    attachChildProcessBridge,
    exit: process.exit.bind(process) as (code?: number) => never,
    writeError: (message: string) => process.stderr.write(message),
  },
): ChildProcess {
  return runRespawnChildWithSignalBridge({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    detachForProcessTree: plan.detachForProcessTree,
    runtime,
    onError: (error) => {
      runtime.writeError(
        `[openclaw] Failed to respawn CLI without compile cache: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
    },
  });
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

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.entryCompileCacheTestApi")] = {
    buildOpenClawCompileCacheRespawnPlan,
    isSourceCheckoutInstallRoot,
    resolveOpenClawCompileCacheDirectory,
    runOpenClawCompileCacheRespawnPlan,
    shouldEnableOpenClawCompileCache,
  };
}
