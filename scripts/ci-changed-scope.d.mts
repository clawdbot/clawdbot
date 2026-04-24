export type ChangedScope = {
  runNode: boolean;
  runMacos: boolean;
  runAndroid: boolean;
  runWindows: boolean;
  runSkillsPython: boolean;
  runChangedSmoke: boolean;
  runControlUiI18n: boolean;
};

export type InstallSmokeScope = {
  runFastInstallSmoke: boolean;
  runFullInstallSmoke: boolean;
};

export function detectChangedScope(changedPaths: string[]): ChangedScope;
export function detectInstallSmokeScope(changedPaths: string[]): InstallSmokeScope;
export function listChangedPaths(base: string, head?: string): string[];
export function writeGitHubOutput(
  scope: ChangedScope,
  outputPath?: string,
  installSmokeScope?: InstallSmokeScope,
): void;
