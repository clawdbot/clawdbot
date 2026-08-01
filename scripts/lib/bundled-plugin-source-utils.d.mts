/** Read a UTF-8 file when it exists, returning null on missing/unreadable paths. */
export function readIfExists(filePath: unknown): string | null;
/** Collect bundled plugin manifests and package metadata from git or the extensions directory. */
export function collectBundledPluginSources(params?: Record<string, unknown>): {
  packageJsonPath?: string;
  packageJson?: unknown;
  dirName: string;
  pluginDir: string;
  manifestPath: string;
  manifest: unknown;
}[];
