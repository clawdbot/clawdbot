import type { ChildProcess } from "node:child_process";
import type { RespawnChildRuntime } from "./process/respawn-child-runner.js";
import "./entry.compile-cache.js";

type CompileCacheParams = {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
};

type CompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree: boolean;
};

type CompileCacheTestApi = {
  buildOpenClawCompileCacheRespawnPlan(params: {
    currentFile: string;
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    execPath?: string;
    installRoot: string;
    argv?: string[];
    compileCacheDir?: string;
    nodeVersion?: string;
    platform?: NodeJS.Platform;
  }): CompileCacheRespawnPlan | undefined;
  isNodeVersionAffectedByCompileCacheDeadlock(nodeVersion: string | undefined): boolean;
  isSourceCheckoutInstallRoot(installRoot: string): boolean;
  resolveOpenClawCompileCacheDirectory(params: {
    env?: NodeJS.ProcessEnv;
    installRoot: string;
  }): string;
  runOpenClawCompileCacheRespawnPlan(
    plan: CompileCacheRespawnPlan,
    runtime?: RespawnChildRuntime & { writeError(message: string): void },
  ): ChildProcess;
  shouldEnableOpenClawCompileCache(params: CompileCacheParams): boolean;
};

function getTestApi(): CompileCacheTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.entryCompileCacheTestApi")
  ] as CompileCacheTestApi;
}

export function buildOpenClawCompileCacheRespawnPlan(
  params: Parameters<CompileCacheTestApi["buildOpenClawCompileCacheRespawnPlan"]>[0],
): CompileCacheRespawnPlan | undefined {
  return getTestApi().buildOpenClawCompileCacheRespawnPlan(params);
}

export function isNodeVersionAffectedByCompileCacheDeadlock(
  nodeVersion: string | undefined,
): boolean {
  return getTestApi().isNodeVersionAffectedByCompileCacheDeadlock(nodeVersion);
}

export function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return getTestApi().isSourceCheckoutInstallRoot(installRoot);
}

export function resolveOpenClawCompileCacheDirectory(
  params: Parameters<CompileCacheTestApi["resolveOpenClawCompileCacheDirectory"]>[0],
): string {
  return getTestApi().resolveOpenClawCompileCacheDirectory(params);
}

export function runOpenClawCompileCacheRespawnPlan(
  ...args: Parameters<CompileCacheTestApi["runOpenClawCompileCacheRespawnPlan"]>
): ChildProcess {
  return getTestApi().runOpenClawCompileCacheRespawnPlan(...args);
}

export function shouldEnableOpenClawCompileCache(params: CompileCacheParams): boolean {
  return getTestApi().shouldEnableOpenClawCompileCache(params);
}
