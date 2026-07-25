#!/usr/bin/env node
/**
 * Resolves the extension memory build timeout from environment.
 */
export type ExtensionMemoryBuildParams = {
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  requiredExtensionIds?: string[];
  rootDir?: string;
  spawnSync?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { error?: Error; status: number | null };
  stdio?: "inherit" | "pipe";
};
export function resolveExtensionMemoryBuildTimeoutMs(env?: NodeJS.ProcessEnv): number;
/**
 * Reports whether built memory extension entries exist.
 */
export function hasBuiltExtensionMemoryEntries(params?: ExtensionMemoryBuildParams): boolean;
/**
 * Builds memory extension entries when required outputs are missing.
 */
export function ensureExtensionMemoryBuild(params?: ExtensionMemoryBuildParams): {
  built: boolean;
};
