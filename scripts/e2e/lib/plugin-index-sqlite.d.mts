export type PluginInstallRecord = Record<string, unknown> & {
  artifactKind?: string;
  gitCommit?: string;
  installPath?: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  source?: string;
  sourcePath?: string;
  spec?: string;
};

export function readPluginInstallIndex(options?: Record<string, unknown>): unknown;
export function readPluginInstallRecords(options?: {
  configPath?: string;
  fallbackRecords?: Record<string, PluginInstallRecord>;
  stateDir?: string;
}): Record<string, PluginInstallRecord>;
export function writePluginInstallIndexForE2E(
  index: unknown,
  options?: Record<string, unknown>,
): void;
