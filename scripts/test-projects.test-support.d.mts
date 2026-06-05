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
  watchMode: boolean;
};

export type ChangedTestTargetOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  broad?: boolean;
};

export type ChangedTestTargetPlan = {
  mode: "none" | "broad" | "targets";
  targets: string[];
  skippedBroadFallbackPaths?: string[];
};

export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS: string;
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS: string;

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

export function findUnmatchedExplicitTestTargets(
  args: string[],
  cwd?: string,
): Array<{
  target: string;
  reason: "glob-matched-no-files" | "path-does-not-exist" | "target-matched-no-test-files";
  includePattern?: string;
}>;

export function applyDefaultVitestNoOutputTimeout(
  specs: VitestRunSpec[],
  params?: {
    env?: Record<string, string | undefined>;
  },
): VitestRunSpec[];

export function applyDefaultMultiSpecVitestCachePaths(
  specs: VitestRunSpec[],
  params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): VitestRunSpec[];

export function writeVitestIncludeFile(filePath: string, includePatterns: string[]): void;

export function buildVitestArgs(args: string[], cwd?: string): string[];
