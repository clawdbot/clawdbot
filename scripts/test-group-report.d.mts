import type { ChildProcess } from "node:child_process";

export type TestGroupReportArgs = {
  allowFailures: boolean;
  compare: { after: string; before: string } | null;
  concurrency: number | null;
  configs: string[];
  fullSuite: boolean;
  groupBy: string;
  help?: boolean;
  killGraceMs: number;
  limit: number;
  maxTestMs: number | null;
  output: string | null;
  reports: string[];
  rss: boolean;
  timeoutMs: number;
  topFiles: number;
  vitestArgs: string[];
};

export type TestGroupRunPlan = {
  config: string;
  forwardedArgs: string[];
  label: string;
};

export type TestGroupRunSpec = TestGroupRunPlan & {
  env: NodeJS.ProcessEnv;
  vitestArgs: string[];
};

export type TestGroupRun = {
  config: string;
  elapsedMs: number;
  label: string;
  logPath: string;
  maxRssBytes: number | null;
  reportPath: string;
  status: number;
};

export function parseTestGroupReportArgs(argv: string[]): TestGroupReportArgs;
export function signalTestGroupReportChild(
  child: Pick<ChildProcess, "kill" | "pid">,
  signal: NodeJS.Signals,
  options?: Record<string, unknown>,
): void;
export function spawnText(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<{ output: string; status: number; signal: NodeJS.Signals | null }>;
export function resolveReportArtifactDirs(outputPath: string): {
  logDir: string;
  reportDir: string;
};
export function resolveRunPlans(args: TestGroupReportArgs): TestGroupRunPlan[];
export function resolveFullSuiteVitestEnv(
  args: TestGroupReportArgs,
  env?: NodeJS.ProcessEnv,
  label?: string,
): NodeJS.ProcessEnv;
export function resolveRunPlanConcurrency(args: TestGroupReportArgs, runPlanCount: number): number;
export function resolveReportVitestArgs(args: TestGroupReportArgs): string[];
export function resolveReportRunSpecs(
  args: TestGroupReportArgs,
  runPlans: TestGroupRunPlan[],
  params?: { cwd?: string; env?: NodeJS.ProcessEnv },
): TestGroupRunSpec[];
export function runReportPlans(params: {
  args: TestGroupReportArgs;
  logDir: string;
  reportDir: string;
  runPlans: TestGroupRunPlan[];
  runVitestJsonReport?: (params: {
    config: string;
    label: string;
    logPath: string;
    reportPath: string;
  }) => Promise<TestGroupRun>;
}): Promise<{
  exitCode: number;
  failed: boolean;
  runEntries: Array<{ config: string; report: unknown }>;
  runs: TestGroupRun[];
}>;
