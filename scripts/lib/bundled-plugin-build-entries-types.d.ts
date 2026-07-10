// Bundled Plugin Build Entries Types.D script supports OpenClaw repository automation.
export type BundledPluginBuildEntry = {
  id: string;
  hasPackageJson: boolean;
  packageJson: unknown;
  sourceEntries: string[];
};

export type BundledPluginBuildEntryParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeRootPackageExcludedDirs?: boolean;
};

export const NON_PACKAGED_BUNDLED_PLUGIN_DIRS: Set<string>;
export const DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV: string;
export function collectRootPackageExcludedExtensionDirs(
  params?: BundledPluginBuildEntryParams,
): Set<string>;
export function collectBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): BundledPluginBuildEntry[];
export function listBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): Record<string, string>;
export function listBundledPluginPackArtifacts(params?: BundledPluginBuildEntryParams): string[];
