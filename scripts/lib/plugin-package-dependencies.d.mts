export type RuntimeDependencyPackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};
export function collectRuntimeDependencySpecs(
  packageJson?: RuntimeDependencyPackageJson,
): Map<string, string>;
export function packageNameFromSpecifier(specifier: string): string | null;
export function collectBundledPluginPackageDependencySpecs(
  bundledPluginsDir: string,
): Map<
  string,
  { conflicts: Array<{ pluginId: string; spec: string }>; pluginIds: string[]; spec: string }
>;
