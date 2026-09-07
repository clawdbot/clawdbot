import { STAGED_INPUT_PATHS_JS } from "../../media/staged-inputs.js";

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
export function isDerivedWorkspacePath(relativePath: string, retainedInput = false): boolean {
  if (retainedInput) {
    return false;
  }
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
${STAGED_INPUT_PATHS_JS}
const DERIVED_WORKSPACE_DIRECTORY_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_DIRECTORY_NAMES)};
const DERIVED_WORKSPACE_FILE_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_NAMES)};
const DERIVED_WORKSPACE_FILE_SUFFIXES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_SUFFIXES)};
const WORKER_ATTACHMENT_DIRECTORY_RE = ${WORKER_ATTACHMENT_DIRECTORY_RE.toString()};
const isDerivedWorkspacePath = ${isDerivedWorkspacePath.toString()};`;

// Standalone node capture/reset scripts cannot import fs-safe. Read only the
// bounded regular marker, rejecting parent aliases and binding bytes to its inode.
export const WORKSPACE_STAGED_INPUT_OWNERSHIP_JS = String.raw`
const stagedInputOwnership = new Map();
function isStagedInput(relativePath) {
  const directory = stagedInputPathDirectory(relativePath);
  if (!directory) return false;
  if (stagedInputOwnership.has(directory)) return stagedInputOwnership.get(directory);
  let owned = false;
  let descriptor;
  try {
    let parent = root;
    for (const segment of directory.split("/")) {
      parent = path.join(parent, segment);
      const stats = fs.lstatSync(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    const marker = path.join(parent, ".gitignore");
    const before = fs.lstatSync(marker);
    if (!before.isFile() || before.nlink !== 1 || before.size !== STAGED_INPUT_GITIGNORE.length) return false;
    descriptor = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) return false;
    const bytes = Buffer.alloc(STAGED_INPUT_GITIGNORE.length + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(marker);
    owned = after.isFile() && after.nlink === 1 && after.dev === opened.dev && after.ino === opened.ino &&
      after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      fs.realpathSync(marker) === marker && length === STAGED_INPUT_GITIGNORE.length &&
      bytes.subarray(0, length).toString("utf8") === STAGED_INPUT_GITIGNORE;
  } catch {
    // An ignored project directory with an absent or unsafe marker is not an input.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    stagedInputOwnership.set(directory, owned);
  }
  return owned;
}`;
