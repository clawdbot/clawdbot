#!/usr/bin/env node
/**
 * Lists all live test files from git/find fallback paths.
 */
export function collectAllLiveTestFiles(repoRoot?: string): string[];
/**
 * Selects the live test files belonging to one shard name.
 */
export function selectLiveShardFiles(shard: string, files?: string[]): string[];
/**
 * Parses live-shard CLI args into shard name and Vitest passthrough args.
 */
export function parseLiveShardArgs(args: string[]): {
  shard: string;
  listOnly: boolean;
  passthroughArgs: string[];
};
/**
 * Builds pnpm/vitest args for selected live test files.
 */
export function buildLiveShardPnpmArgs(files: string[], passthroughArgs: string[]): string[];
/**
 * Resolves build profiles required by selected live tests.
 */
export function resolveLiveShardPreparation(files: unknown): {
  env: {
    OPENCLAW_BUILD_PRIVATE_QA: string;
  };
  profile: string;
  requiredArtifact: string;
} | null;
/**
 * Builds the Vitest JSON report path used to prove that a live shard ran tests.
 */
export function buildLiveShardReportPath(shard: string, env?: NodeJS.ProcessEnv): string;
/**
 * Adds reporters needed for both operator logs and machine-readable evidence.
 */
export function addLiveShardReportArgs(passthroughArgs: string[], reportPath: string): string[];
/**
 * Removes a previous JSON report before a shard run so stale success cannot be reused.
 */
export function removeLiveShardReportFile(reportPath: string): void;
/**
 * Validates a Vitest JSON payload for live-shard proof.
 */
export function validateLiveShardReportPayload(
  payload: unknown,
  expectedFiles?: unknown[],
  repoRoot?: string,
  env?: NodeJS.ProcessEnv,
):
  | {
      ok: boolean;
      reason: string;
    }
  | {
      ok: boolean;
      reason?: undefined;
    };
/**
 * Builds spawn options for the live-shard Vitest child.
 */
export function buildLiveShardSpawnParams(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): {
  detached: boolean;
  env: NodeJS.ProcessEnv;
  stdio: string;
};
/** Live-test shards included in release validation. */
export const RELEASE_LIVE_TEST_SHARDS: readonly string[];
/** All live-test shards, including broader local-only shard aliases. */
export const LIVE_TEST_SHARDS: readonly string[];
