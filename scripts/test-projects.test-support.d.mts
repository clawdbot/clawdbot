import type { VitestHostInfo } from "./lib/vitest-local-scheduling.mjs";

export type VitestRunPlan = {
  config: string;
  forwardedArgs: string[];
  includePatterns: string[] | null;
  watchMode: boolean;
};

export type VitestRunSpec = {
  config: string;
  env: Record<string, string | undefined>;
  includeFilePath: string | null;
  includePatterns: string[] | null;
  pnpmArgs: string[];
  preflightPnpmArgs: string[] | null;
  watchMode: boolean;
};

export type FailedVitestShard = {
  code?: number | null;
  config: string;
  includePatterns?: string[] | null;
  noOutputTimedOut?: boolean;
  order?: number;
  signal?: string | null;
};

export type ChangedTestTargetOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  broad?: boolean;
  combineSiblingWithImportGraph?: boolean;
  forceFullImportGraph?: boolean;
  includeExtensionImpact?: boolean;
};

export type ChangedTestTargetPlan = {
  mode: "none" | "broad" | "targets";
  targets: string[];
  skippedBroadFallbackPaths?: string[];
};

export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS: string;
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS: string;
export const CHANNEL_CONTRACT_CONFIG_PATTERNS: ReadonlyMap<string, readonly string[]>;

export function orderFullSuiteSpecsForParallelRun<T extends { config: string }>(
  specs: T[],
  shardTimings?: ReadonlyMap<string, number>,
): T[];

export function formatNoChangedTestTargetLines(skippedBroadFallbackPaths: string[]): string[];

export function parseTestProjectsArgs(
  args: string[],
  cwd?: string,
): {
  forwardedArgs: string[];
  targetArgs: string[];
  watchMode: boolean;
};

export function buildVitestRunPlans(
  args: string[],
  cwd?: string,
  listChangedPaths?: (baseRef: string, cwd: string) => string[],
  options?: ChangedTestTargetOptions,
): VitestRunPlan[];

export function buildFullSuiteVitestRunPlans(args: string[], cwd?: string): VitestRunPlan[];

export function resolveParallelFullSuiteConcurrency(
  specCount: number,
  env?: Record<string, string | undefined>,
  hostInfo?: VitestHostInfo,
): number;

export function resolveChangedTargetArgs(
  args: string[],
  cwd?: string,
  listChangedPaths?: (baseRef: string, cwd: string) => string[],
  options?: ChangedTestTargetOptions,
): string[] | null;

export function resolveChangedTestTargetPlan(
  changedPaths: string[],
  options?: ChangedTestTargetOptions,
): ChangedTestTargetPlan;

export function hasImportGraphImpactOnTargets(
  changedPaths: string[],
  targetPaths: string[],
  cwd?: string,
): boolean;

export function resolveChangedTestTargetPlanForArgs(
  args: string[],
  cwd?: string,
  listChangedPaths?: (baseRef: string, cwd: string) => string[],
  options?: ChangedTestTargetOptions,
): ChangedTestTargetPlan | null;

export function listFullExtensionVitestProjectConfigs(): string[];

export function createVitestRunSpecs(
  args: string[],
  params?: {
    baseEnv?: Record<string, string | undefined>;
    cwd?: string;
    tempDir?: string;
  },
): VitestRunSpec[];

export function createVitestPreflightPnpmArgs(config: string): string[] | null;

export function isTestFileTarget(arg: string): boolean;

export function findUnmatchedExplicitTestTargets(
  args: string[],
  cwd?: string,
): Array<{
  target: string;
  reason: "glob-matched-no-files" | "path-does-not-exist" | "target-matched-no-test-files";
  includePattern?: string;
}>;

export function applyDefaultVitestNoOutputTimeout<
  T extends { config: string; env: NodeJS.ProcessEnv; watchMode: boolean },
>(
  specs: T[],
  params?: {
    env?: Record<string, string | undefined>;
  },
): Array<Omit<T, "env"> & { env: NodeJS.ProcessEnv }>;

export function applyDefaultMultiSpecVitestCachePaths<
  T extends { config: string; env: NodeJS.ProcessEnv; watchMode: boolean },
>(
  specs: T[],
  params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Array<Omit<T, "env"> & { env: NodeJS.ProcessEnv }>;

export function applyParallelVitestCachePaths<T extends { config: string; env: NodeJS.ProcessEnv }>(
  specs: T[],
  params?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Array<Omit<T, "env"> & { env: NodeJS.ProcessEnv }>;

export function shouldRetryVitestNoOutputTimeout(env?: Record<string, string | undefined>): boolean;
export function withRetryNoOutputTimeout<T extends { env?: Record<string, string | undefined> }>(
  spec: T,
): T;

export function shouldAcquireLocalHeavyCheckLock(
  runSpecs: Array<Pick<VitestRunSpec, "config" | "includePatterns" | "watchMode">>,
  env?: Record<string, string | undefined>,
): boolean;

export function writeVitestIncludeFile(
  filePath: string,
  includePatterns: string[],
  options?: { cwd?: string; expandGlobs?: boolean },
): void;

export function formatFailedShardDigest(
  failures: FailedVitestShard[],
  options?: { limit?: number },
): string[];

export function buildVitestArgs(args: string[], cwd?: string): string[];
