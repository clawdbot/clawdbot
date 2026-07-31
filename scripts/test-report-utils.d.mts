/**
 * Normalizes absolute or relative file names to repo-relative POSIX paths.
 */
export function normalizeTrackedRepoPath(value: unknown): unknown;
/**
 * Reads and parses a JSON file.
 */
export function readJsonFile(filePath: unknown): unknown;
/**
 * Reads a JSON file or returns the provided fallback on failure.
 */
export function tryReadJsonFile(filePath: unknown, fallback: unknown): unknown;
/**
 * Runs Vitest with the JSON reporter unless an existing report was supplied.
 */
export function runVitestJsonReport({
  config,
  reportPath,
  prefix,
}: {
  config: unknown;
  reportPath?: string | undefined;
  prefix?: string | undefined;
}): string;
/**
 * Extracts per-file durations from a Vitest JSON report.
 */
export function collectVitestFileDurations(
  report: unknown,
  normalizeFile?: (value: unknown) => unknown,
): unknown;
/**
 * Extracts per-assertion durations from a Vitest JSON report.
 */
export function collectVitestAssertionDurations(
  report: unknown,
  normalizeFile?: (value: unknown) => unknown,
): unknown;
