export type BundledPluginBuildEntry = {
  id: string;
  hasPackageJson: boolean;
  packageJson: unknown;
  sourceEntries: string[];
};

export type BundledPluginBuildEntryParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export const NON_PACKAGED_BUNDLED_PLUGIN_DIRS: Set<string>;
export function collectBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): BundledPluginBuildEntry[];
export function listBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): Record<string, string>;
export function listBundledPluginPackArtifacts(params?: BundledPluginBuildEntryParams): string[];
