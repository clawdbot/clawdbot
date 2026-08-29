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
const UUID_HEX = "[0-9a-f]";
// randomUUID creates lowercase UUIDv4 names. This exact character-class pattern
// has the same meaning in a regular expression and an rsync exclusion glob.
export const WORKER_ATTACHMENT_DIRECTORY_PATTERN =
  WORKER_ATTACHMENT_DIRECTORY_PREFIX +
  [
    UUID_HEX.repeat(8),
    UUID_HEX.repeat(4),
    `4${UUID_HEX.repeat(3)}`,
    `[89ab]${UUID_HEX.repeat(3)}`,
    UUID_HEX.repeat(12),
  ].join("-");
const WORKER_ATTACHMENT_DIRECTORY_RE = new RegExp(`^${WORKER_ATTACHMENT_DIRECTORY_PATTERN}$`);

// Derived caches and runtime attachment copies are not workspace edits. Keep
// sync, manifest, divergence, apply, and recovery on this single predicate.
export function isDerivedWorkspacePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  // "$" can match before a final newline; require the entire path segment.
  return segments.some(
    (segment) =>
      WORKER_ATTACHMENT_DIRECTORY_RE.exec(segment)?.[0] === segment ||
      (DERIVED_WORKSPACE_DIRECTORY_NAMES as readonly string[]).includes(segment) ||
      (DERIVED_WORKSPACE_FILE_NAMES as readonly string[]).includes(segment) ||
      DERIVED_WORKSPACE_FILE_SUFFIXES.some((suffix) => segment.endsWith(suffix)),
  );
}

export const DERIVED_WORKSPACE_RSYNC_EXCLUDES = [
  ...DERIVED_WORKSPACE_DIRECTORY_NAMES,
  ...DERIVED_WORKSPACE_FILE_NAMES,
  ...DERIVED_WORKSPACE_FILE_SUFFIXES.map((suffix) => `*${suffix}`),
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
] as const;

export const WORKSPACE_PATH_EXCLUSIONS_JS = `
const DERIVED_WORKSPACE_DIRECTORY_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_DIRECTORY_NAMES)};
const DERIVED_WORKSPACE_FILE_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_NAMES)};
const DERIVED_WORKSPACE_FILE_SUFFIXES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_SUFFIXES)};
const WORKER_ATTACHMENT_DIRECTORY_RE = ${WORKER_ATTACHMENT_DIRECTORY_RE.toString()};
const isDerivedWorkspacePath = ${isDerivedWorkspacePath.toString()};`;
