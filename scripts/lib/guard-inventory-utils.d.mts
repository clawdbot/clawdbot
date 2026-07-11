/** Convert an absolute file path to a repo-relative POSIX path. */
export function normalizeRepoPath(repoRoot: unknown, filePath: unknown): string;
/** Resolve a relative or absolute module specifier to a repo-relative path. */
export function resolveRepoSpecifier(
  repoRoot: unknown,
  specifier: unknown,
  importerFile: unknown,
): string | null;
/** Visit static and dynamic module specifiers in a parsed TypeScript source file. */
export function visitModuleSpecifiers(ts: unknown, sourceFile: unknown, visit: unknown): void;
/** Diff expected and actual inventory entries using JSON identity. */
export function diffInventoryEntries(
  expected: unknown,
  actual: unknown,
  compareEntries: unknown,
): {
  missing: unknown;
  unexpected: unknown;
};
/** Write one line to a stream without each caller repeating newline handling. */
export function writeLine(stream: unknown, text: unknown): void;
/** Collect import/export/dynamic-import references from source text without full parsing. */
export function collectModuleReferencesFromSource(source: unknown): unknown[];
/** Memoize an async factory while resetting the cache after failures. */
export function createCachedAsync(factory: unknown): () => Promise<unknown>;
/** Format grouped inventory entries for human-readable guard output. */
export function formatGroupedInventoryHuman(params: unknown, inventory: unknown): string;
/** Parse TypeScript files and collect sorted inventory entries from each source file. */
export function collectTypeScriptInventory(params: unknown): Promise<unknown[]>;
/** Run a baseline inventory check and return the intended process exit code. */
export function runBaselineInventoryCheck(params: unknown): Promise<1 | 0>;
