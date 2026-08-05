/** Source roots whose changes require the root dev build pipeline. */
export const runNodeSourceRoots: string[];
/** Root config files whose changes invalidate the dev build. */
export const runNodeConfigFiles: string[];
/** Combined watch list used by the run-node wrapper. */
export const runNodeWatchedPaths: string[];
/** Plugin metadata files that require a runtime restart even without source edits. */
export const extensionRestartMetadataFiles: Set<string>;

export interface RunNodePathClassifier {
  refreshGeneratedPluginAssetPaths(): void;
  isBuildRelevantRunNodePath(repoPath: unknown): boolean;
  isRestartRelevantRunNodePath(repoPath: unknown): boolean;
}

/** Creates a path classifier whose generated-output metadata can be refreshed. */
export function createRunNodePathClassifier(params?: { rootDir?: string }): RunNodePathClassifier;

/** Normalizes watch paths to repository-style POSIX separators. */
export function normalizeRunNodePath(filePath: unknown): string;
/** Returns true when a repo path should trigger a dev rebuild. */
export function isBuildRelevantRunNodePath(repoPath: unknown): boolean;
/** Returns true when a repo path should restart the running dev process. */
export function isRestartRelevantRunNodePath(repoPath: unknown): boolean;
