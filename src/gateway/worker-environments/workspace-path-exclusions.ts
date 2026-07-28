export const DERIVED_WORKSPACE_DIRECTORY_NAMES = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
] as const;

export const DERIVED_WORKSPACE_FILE_NAMES = [".DS_Store"] as const;
export const DERIVED_WORKSPACE_FILE_SUFFIXES = [".pyc", ".pyo"] as const;

// Derived caches must never fence workspace reconciliation. Keep every sync,
// manifest, divergence, apply, and recovery path on this single predicate.
export function isDerivedWorkspacePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some(
    (segment) =>
      (DERIVED_WORKSPACE_DIRECTORY_NAMES as readonly string[]).includes(segment) ||
      (DERIVED_WORKSPACE_FILE_NAMES as readonly string[]).includes(segment) ||
      DERIVED_WORKSPACE_FILE_SUFFIXES.some((suffix) => segment.endsWith(suffix)),
  );
}

export const DERIVED_WORKSPACE_RSYNC_EXCLUDES = [
  ...DERIVED_WORKSPACE_DIRECTORY_NAMES,
  ...DERIVED_WORKSPACE_FILE_NAMES,
  ...DERIVED_WORKSPACE_FILE_SUFFIXES.map((suffix) => `*${suffix}`),
] as const;
