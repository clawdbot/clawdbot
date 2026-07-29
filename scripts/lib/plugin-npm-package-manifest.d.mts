/** Resolve an npm command invocation for plugin package scripts. */
export function resolvePluginNpmCommand(
  args: unknown,
  params?: Record<string, unknown>,
): {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};
/** Build the package.json that should be used while packaging a plugin for npm. */
export function resolveAugmentedPluginNpmPackageJson(params: unknown):
  | {
      packageJsonPath: string;
      packageDir: unknown;
      repoRoot: string;
      changed: boolean;
      packageJson: undefined;
      reason: string;
      pluginDir?: undefined;
      bundleDependencies?: undefined;
    }
  | {
      packageJsonPath: string;
      packageDir: unknown;
      repoRoot: string;
      changed: boolean;
      packageJson: Record<string, unknown>;
      pluginDir: string;
      bundleDependencies: boolean;
      reason: string;
    };
/** Read generated bundled channel config metadata keyed by plugin id. */
export function readGeneratedBundledChannelConfigs(repoRoot: unknown): Map<unknown, unknown>;
/** Merge generated channel config schemas into a plugin manifest without clobbering labels. */
export function mergeGeneratedChannelConfigs(
  manifest: unknown,
  generatedChannelConfigs: unknown,
): unknown;
/** Build the plugin manifest that should be used while packaging a plugin for npm. */
export function resolveAugmentedPluginNpmManifest(params: unknown): {
  manifestPath: string;
  pluginId: unknown;
  changed: boolean;
  manifest: unknown;
  reason: string;
};
/** Temporarily write augmented manifest/package metadata while a packaging callback runs. */
export function withAugmentedPluginNpmManifestForPackage(
  params: unknown,
  callback: unknown,
): unknown;
export function parseRunArgs(argv: unknown):
  | {
      help: true;
      packageDir: string;
      command: string;
      args: string[];
    }
  | {
      packageDir: string;
      command: string;
      args: string[];
      help?: undefined;
    };
