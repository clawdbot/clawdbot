// Shared command-path matching helpers for CLI startup and registration policy.

/** Matches a command path prefix, or the full path when `exact` is requested. */
export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    return false;
  }
  return !params?.exact || commandPath.length === pattern.length;
}
