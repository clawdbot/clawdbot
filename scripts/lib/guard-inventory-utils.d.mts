/** Convert an absolute file path to a repo-relative POSIX path. */
export function normalizeRepoPath(repoRoot: unknown, filePath: unknown): string;
/** Resolve a relative or absolute module specifier to a repo-relative path. */
export function resolveRepoSpecifier(
  repoRoot: unknown,
  specifier: unknown,
  importerFile: unknown,
): string | null;
/** Visit module specifiers, optionally including packaged-runtime dependencies. */
export function visitModuleSpecifiers(
  ts: unknown,
  sourceFile: unknown,
  visit: unknown,
  options?: {
    includeCommonJs?: boolean;
    includeImportMetaUrl?: boolean;
    includeImportTypes?: boolean;
  },
): void;
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
/** Lexically reject clean files before parsing candidate module-boundary violations. */
export function collectModuleReferencesFromSource(
  source: string,
  options?: {
    acceptSpecifier?: (specifier: string) => boolean;
    fileName?: string;
    ts?: unknown;
  },
): Array<{ kind: string; line: number; specifier: string }>;
/** Memoize an async factory while resetting the cache after failures. */
export function createCachedAsync(factory: unknown): () => Promise<unknown>;
/** Format grouped inventory entries for human-readable guard output. */
export function formatGroupedInventoryHuman(params: unknown, inventory: unknown): string;
/** Parse TypeScript files and collect sorted inventory entries from each source file. */
export function collectTypeScriptInventory(params: unknown): Promise<unknown[]>;
/** Run a baseline inventory check and return the intended process exit code. */
export function runBaselineInventoryCheck(params: unknown): Promise<1 | 0>;
