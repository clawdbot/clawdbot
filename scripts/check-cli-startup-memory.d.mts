#!/usr/bin/env node
export namespace testing {
  export { cases };
  export { nodeImportSpecifierForPath };
  export { parseArgs };
  export { readPositiveIntEnv };
  export { readPositiveNumberEnv };
  export { repoRoot };
  export { resolveDefaultLimitsMb };
  export { runCase };
  export { runStartupMemoryCheck };
  export { sampleCount };
}
declare const cases: {
  id: string;
  label: string;
  args: string[];
  limitMb: unknown;
}[];
declare function nodeImportSpecifierForPath(filePath: unknown): string;
declare function parseArgs(argv: unknown): {
  jsonPath: string;
  summaryPath: string;
};
declare function readPositiveIntEnv(
  name: unknown,
  fallback: unknown,
  env?: NodeJS.ProcessEnv,
): unknown;
declare function readPositiveNumberEnv(
  name: unknown,
  fallback: unknown,
  env?: NodeJS.ProcessEnv,
): unknown;
declare const repoRoot: string;
declare const sampleCount: number;
declare function resolveDefaultLimitsMb(platform?: NodeJS.Platform): {
  help: number;
  pluginsList: number;
  statusJson: number;
  gatewayStatus: number;
};
declare function runCase(
  testCase: unknown,
  params?: Record<string, unknown>,
): {
  id: unknown;
  label: unknown;
  command: string;
  limitMb: unknown;
  maxRssMb: number | null;
  rssSamplesMb?: number[];
  status: string;
  exitCode: unknown;
  signal: unknown;
  error: string | null;
};
declare function runStartupMemoryCheck(
  argv?: string[],
  params?: Record<string, unknown>,
): {
  skipped: boolean;
  results: {
    id: unknown;
    label: unknown;
    command: string;
    limitMb: unknown;
    maxRssMb: number | null;
    rssSamplesMb?: number[];
    status: string;
    exitCode: unknown;
    signal: unknown;
    error: string | null;
  }[];
};
