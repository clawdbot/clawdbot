#!/usr/bin/env node
export function parseArgs(argv: unknown):
  | {
      help: true;
      packageDirs: string[];
    }
  | {
      packageDirs: string[];
      help?: undefined;
    };
/**
 * Builds publishable plugin npm runtimes and verifies declared outputs exist.
 */
export function checkPluginNpmRuntimeBuilds(params?: Record<string, unknown>): Promise<
  {
    pluginDir: string;
    status: string;
    entryCount: number;
    copiedStaticAssets: string[];
  }[]
>;
