#!/usr/bin/env node
/**
 * Reads bundled plugin asset hook commands for a build or copy phase.
 */
export function readBundledPluginAssetHooks(options?: Record<string, unknown>): Promise<
  {
    aliases: string[];
    command: string;
    packageName: unknown;
    phase: unknown;
    pluginDir: string;
    pluginId: string;
  }[]
>;
/**
 * Runs bundled plugin asset hook commands for the selected phase/plugins.
 */
export function runBundledPluginAssetHooks(options?: Record<string, unknown>): Promise<void>;
/**
 * Parses `--phase` and repeated `--plugin` flags for asset hook scripts.
 */
export function parseBundledPluginAssetArgs(argv: unknown): {
  phase: unknown;
  plugins: unknown[];
};
