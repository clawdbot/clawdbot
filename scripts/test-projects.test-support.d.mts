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
): VitestRunPlan[];

export function resolveChangedTargetArgs(
  args: string[],
  cwd?: string,
  listChangedPaths?: (baseRef: string, cwd: string) => string[],
): string[] | null;

export function resolveChangedTestTargetPlan(changedPaths: string[]): {
  mode: "none" | "broad" | "targets";
  targets: string[];
};

export function listFullExtensionVitestProjectConfigs(): string[];

export function createVitestRunSpecs(
  args: string[],
  params?: {
    baseEnv?: Record<string, string | undefined>;
    cwd?: string;
    tempDir?: string;
  },
): VitestRunSpec[];

export function writeVitestIncludeFile(filePath: string, includePatterns: string[]): void;

export function buildVitestArgs(args: string[], cwd?: string): string[];
