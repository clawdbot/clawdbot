import type { ChangedLaneResult } from "./changed-lanes.mjs";

export type ChangedCheckCommand = {
  name: string;
  args: string[];
  bin?: string;
  env?: NodeJS.ProcessEnv;
};

export type ChangedCheckPlan = {
  commands: ChangedCheckCommand[];
  summary: string;
};

export type ChangedCheckPlanOptions = {
  env?: NodeJS.ProcessEnv;
  staged?: boolean;
  base?: string;
  head?: string;
  platform?: NodeJS.Platform;
  swiftlintAvailable?: boolean;
};

export type TargetedLintOptions = {
  fileExists?: (path: string) => boolean;
};

export type TargetedLintCommand = Required<
  Pick<ChangedCheckCommand, "name" | "bin" | "args" | "env">
>;

export function createChangedCheckChildEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function changedCheckLocalDependenciesReady(cwd?: string): boolean;
export function changedCheckRequiresRemote(result?: ChangedLaneResult): boolean;
export function shouldDelegateChangedCheckToCrabbox(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
  options?: { cwd?: string; result?: ChangedLaneResult; diffRefsReady?: boolean },
): boolean;
export function buildChangedCheckCrabboxArgs(argv?: string[], options?: { cwd?: string }): string[];
export function shouldRunShrinkwrapGuard(paths: string[]): boolean;
export function shouldRunPromptSnapshotCheck(paths: string[]): boolean;
export function shouldRunPromptSnapshotOwnerTest(paths: string[]): boolean;
export function shouldRunControlUiI18nVerify(paths: string[]): boolean;
export function shouldRunRuntimeSidecarBaselineCheck(paths: string[]): boolean;
export function shouldRunSqliteSessionSchemaBaselineCheck(paths: string[]): boolean;
export function shouldRunPluginSdkApiBaselineCheck(paths: string[]): boolean;
export function shouldRunPluginSdkSurfaceChecks(paths: string[]): boolean;
export function shouldRunDeprecationHygieneChecks(paths: string[]): boolean;
export function shouldRunCanvasA2uiNativeResourceCheck(paths: string[]): boolean;
export function shouldRunAppcastOwnerTest(paths: string[]): boolean;
export function shouldRunTestTempCreationReport(paths: string[]): boolean;
export function createShrinkwrapGuardCommand(paths: string[]): ChangedCheckCommand | null;
export function createChangedCheckPlan(
  result: ChangedLaneResult,
  options?: ChangedCheckPlanOptions,
): ChangedCheckPlan;
export function createTargetedCoreLintCommand(
  paths: string[],
  env?: NodeJS.ProcessEnv,
  options?: TargetedLintOptions,
): TargetedLintCommand | null;
export function createTargetedExtensionLintCommand(
  paths: string[],
  env?: NodeJS.ProcessEnv,
  options?: TargetedLintOptions,
): TargetedLintCommand | null;
export function createTargetedScriptLintCommand(
  paths: string[],
  env?: NodeJS.ProcessEnv,
  options?: TargetedLintOptions,
): TargetedLintCommand | null;
export function createPnpmManagedCommand<T extends ChangedCheckCommand>(
  command: T,
  env?: NodeJS.ProcessEnv,
): T & { bin: string; env: NodeJS.ProcessEnv };
export function cleanupCorepackPnpmShimDir(): void;
