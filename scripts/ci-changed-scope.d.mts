export type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runIosBuild: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
  runChangedSmoke: boolean;
  runControlUiI18n: boolean;
  runUiTests: boolean;
};

export type InstallSmokeScope = {
  runFastInstallSmoke: boolean;
  runFullInstallSmoke: boolean;
};

export type NodeFastScope = {
  runFastOnly: boolean;
  runPluginContracts: boolean;
  runCiRouting: boolean;
};

export type ChangedScopeArgs = {
  base: string;
  head: string;
  mergeHeadFirstParent: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function shouldRunNativeI18n(changedPaths: string[]): boolean;
export function shouldRunTsLoc(changedPaths: string[]): boolean;
export function detectNodeFastScope(changedPaths: string[]): NodeFastScope;
export function detectInstallSmokeScope(changedPaths: string[]): InstallSmokeScope;
export function listChangedPaths(
  base: string,
  head?: string,
  cwd?: string,
  preferMergeHeadFirstParent?: boolean,
): string[];
export function writeGitHubOutput(
  scope: ChangedScope,
  outputPath?: string,
  installSmokeScope?: InstallSmokeScope,
  nodeFastScope?: NodeFastScope,
  runNativeI18n?: boolean,
  runTsLoc?: boolean,
  changedPaths?: string[] | null,
): void;

export function parseArgs(argv: string[]): ChangedScopeArgs;
