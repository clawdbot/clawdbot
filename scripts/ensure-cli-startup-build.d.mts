#!/usr/bin/env node
/**
 * Resolves the CLI startup build timeout from environment.
 */
export type StartupBuildParams = {
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  rootDir?: string;
  spawnSync?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { error?: Error; status?: number | null };
  stdio?: "inherit" | "pipe";
};
export function resolveCliStartupBuildTimeoutMs(env?: NodeJS.ProcessEnv): number;
/**
 * Reports whether required CLI startup build outputs exist.
 */
export function hasCliStartupBuild(params?: StartupBuildParams): boolean;
/**
 * Builds CLI startup assets when required outputs are missing.
 */
export function ensureCliStartupBuild(params?: StartupBuildParams): {
  built: boolean;
};
