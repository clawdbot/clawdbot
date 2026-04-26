export type VitestHostInfo = {
  cpuCount?: number;
  loadAverage1m?: number;
  totalMemoryBytes?: number;
};

export type LocalVitestScheduling = {
  maxWorkers: number;
  fileParallelism: boolean;
  throttledBySystem: boolean;
};

export const DEFAULT_LOCAL_FULL_SUITE_PARALLELISM: number;
export const LARGE_LOCAL_FULL_SUITE_PARALLELISM: number;
export const DEFAULT_LOCAL_FULL_SUITE_VITEST_WORKERS: number;
export const LARGE_LOCAL_FULL_SUITE_VITEST_WORKERS: number;

export function isCiLikeEnv(env?: Record<string, string | undefined>): boolean;
export function resolveLocalVitestEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function detectVitestHostInfo(): Required<VitestHostInfo>;
export function resolveLocalVitestMaxWorkers(
  env?: Record<string, string | undefined>,
  system?: VitestHostInfo,
  pool?: "forks" | "threads",
): number;
export function resolveLocalVitestScheduling(
  env?: Record<string, string | undefined>,
  system?: VitestHostInfo,
  pool?: "forks" | "threads",
): LocalVitestScheduling;
export function shouldUseLargeLocalFullSuiteProfile(
  env?: Record<string, string | undefined>,
  system?: VitestHostInfo,
): boolean;
export function resolveLocalFullSuiteProfile(
  env?: Record<string, string | undefined>,
  system?: VitestHostInfo,
): {
  shardParallelism: number;
  vitestMaxWorkers: number;
};
