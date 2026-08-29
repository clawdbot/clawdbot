const DERIVED_WORKSPACE_DIRECTORY_NAMES = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
] as const;

const DERIVED_WORKSPACE_FILE_NAMES = [".DS_Store"] as const;
const DERIVED_WORKSPACE_FILE_SUFFIXES = [".pyc", ".pyo"] as const;
export const WORKER_ATTACHMENT_DIRECTORY_PREFIX = "openclaw-inbound-";

// Derived caches and runtime attachment copies are not workspace edits. Keep
// sync, manifest, divergence, apply, and recovery on this single predicate.
export function isDerivedWorkspacePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some(
    (segment) =>
      segment.startsWith(WORKER_ATTACHMENT_DIRECTORY_PREFIX) ||
      (DERIVED_WORKSPACE_DIRECTORY_NAMES as readonly string[]).includes(segment) ||
      (DERIVED_WORKSPACE_FILE_NAMES as readonly string[]).includes(segment) ||
      DERIVED_WORKSPACE_FILE_SUFFIXES.some((suffix) => segment.endsWith(suffix)),
  );
}

export const DERIVED_WORKSPACE_RSYNC_EXCLUDES = [
  ...DERIVED_WORKSPACE_DIRECTORY_NAMES,
  ...DERIVED_WORKSPACE_FILE_NAMES,
  ...DERIVED_WORKSPACE_FILE_SUFFIXES.map((suffix) => `*${suffix}`),
  `${WORKER_ATTACHMENT_DIRECTORY_PREFIX}*`,
] as const;

export const WORKSPACE_PATH_EXCLUSIONS_JS = `
const DERIVED_WORKSPACE_DIRECTORY_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_DIRECTORY_NAMES)};
const DERIVED_WORKSPACE_FILE_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_NAMES)};
const DERIVED_WORKSPACE_FILE_SUFFIXES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_SUFFIXES)};
const WORKER_ATTACHMENT_DIRECTORY_PREFIX = ${JSON.stringify(WORKER_ATTACHMENT_DIRECTORY_PREFIX)};
const isDerivedWorkspacePath = ${isDerivedWorkspacePath.toString()};`;
