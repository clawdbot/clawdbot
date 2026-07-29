#!/usr/bin/env node
export namespace testing {
  export { hasPrivateQaDist };
  export { parseArgs };
  export { readStartupReport };
  export { runGatewayCpuScenarios };
  export { validateStartupReport };
}
declare function hasPrivateQaDist(repoRoot: unknown, fsImpl?: typeof fs): boolean;
declare function parseArgs(argv: string[]): {
  outputDir: string;
  startupCases: string[];
  qaScenarios: string[];
  runs: number;
  warmup: number;
  skipStartup: boolean;
  skipQa: boolean;
  cpuCoreWarn: number;
  hotWallWarnMs: number;
};
declare function readStartupReport(startupOutput: unknown):
  | {
      diagnosticFailure: string;
      diagnosticDetail: string;
      report: null;
    }
  | {
      diagnosticFailure: null;
      diagnosticDetail: null;
      report: unknown;
    };
declare function runGatewayCpuScenarios(
  options: unknown,
  params?: Record<string, unknown>,
): Promise<{
  exitCode: number;
  summary: {
    options: {
      startupCases: unknown;
      qaScenarios: unknown;
      runs: unknown;
      warmup: unknown;
      cpuCoreWarn: unknown;
      hotWallWarnMs: unknown;
      qaStateDir: string | null;
    };
    steps: {
      error?: unknown;
      name: unknown;
      status: unknown;
      signal: unknown;
    }[];
    observations: (
      | {
          kind: string;
          id: unknown;
          cpuCoreRatioMax: number;
          wallMsMax: number;
          cpuCoreRatio?: undefined;
          wallMs?: undefined;
        }
      | {
          kind: string;
          id: string;
          cpuCoreRatio: number;
          wallMs: number;
          cpuCoreRatioMax?: undefined;
          wallMsMax?: undefined;
        }
    )[];
    qaSummaryFailure?: string | undefined;
    qaSummaryFailureDetail?: string | null | undefined;
    startupReportFailure?: string | undefined;
    startupReportFailureDetail?: string | null | undefined;
    generatedAt: string;
    outputDir: unknown;
    startupOutput: string | null;
    qaSummary: string | null;
  };
}>;
declare function validateStartupReport(
  report: unknown,
):
  | "startup report must be a JSON Record<string, unknown>"
  | "startup report missing results array"
  | "startup report has no measured results"
  | null;
import fs from "node:fs";
