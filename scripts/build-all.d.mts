import type fs from "node:fs";

export type BuildCacheEntry =
  | string
  | {
      path: string;
      extensions?: string[];
      recursive?: boolean;
    };

export type BuildAllStep = {
  label: string;
  kind?: "node" | "pnpm";
  args?: string[];
  pnpmArgs?: string[];
  env?: NodeJS.ProcessEnv;
  windowsNodeOptions?: string;
  cache?: {
    env?: string[];
    inputs: BuildCacheEntry[];
    outputs: BuildCacheEntry[];
    restore?: "always";
  };
};

export type BuildAllCacheState = {
  cacheable: boolean;
  fresh: boolean;
  restorable?: boolean;
  reason: string;
  signature?: string;
  outputRoot?: string;
  stampPath?: string;
  inputFiles?: number;
  outputFiles?: number;
  relativeOutputFiles?: string[];
  stampedOutputs?: string[];
};

export const BUILD_ALL_STEPS: BuildAllStep[];
export const BUILD_ALL_PROFILES: Record<string, string[]>;
export const BUILD_ALL_PROFILE_STEP_ENV: Record<string, Record<string, NodeJS.ProcessEnv>>;

export function buildAllUsage(): string;
export function parseBuildAllArgs(argv: string[]): { help: boolean; profile: string };
export function resolveBuildAllSteps(profile?: string): BuildAllStep[];
export function resolveBuildAllEnvironment(
  env?: NodeJS.ProcessEnv,
  now?: () => Date,
  readGitCommit?: () => string | null,
): { [key: string]: string | undefined; OPENCLAW_BUILD_TIMESTAMP: string };
export function resolveBuildAllStep(
  step: BuildAllStep,
  params?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    nodeExecPath?: string;
    npmExecPath?: string;
    comSpec?: string;
  },
): {
  command: string;
  args: string[];
  options: {
    stdio: "inherit";
    env: NodeJS.ProcessEnv;
    shell?: boolean;
    windowsVerbatimArguments?: boolean;
  };
};
export function resolveBuildAllStepCacheState(
  step: BuildAllStep,
  params?: { rootDir?: string; fs?: typeof fs; env?: NodeJS.ProcessEnv },
): BuildAllCacheState;
export function writeBuildAllStepCacheStamp(
  step: BuildAllStep,
  cacheState: BuildAllCacheState,
  params?: { rootDir?: string; fs?: typeof fs },
): void;
export function resolveBuildAllStepCacheStampState(
  step: BuildAllStep,
  cacheState: BuildAllCacheState,
  params?: { rootDir?: string; fs?: typeof fs },
): BuildAllCacheState;
export function restoreBuildAllStepCacheOutputs(
  cacheState: BuildAllCacheState,
  params?: { rootDir?: string; fs?: typeof fs },
): boolean;
export function formatBuildAllDuration(durationMs: number): string;
export function formatBuildAllTimingSummary(
  timings: Array<{ label: string; durationMs: number; status: string }>,
): string;
