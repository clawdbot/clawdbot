import { STAGED_INPUT_GIT_PATHSPEC } from "../../media/staged-inputs.js";
import {
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  selectWorkerWorkspaceHashMemoEntries,
  workspaceStatIdentity,
} from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import {
  REMOTE_WORKSPACE_MANIFEST_CANONICAL_JS,
  REMOTE_WORKSPACE_MANIFEST_REGISTRY_JS,
} from "./workspace-manifest-remote-script.js";
import { MAX_RECONCILIATION_ENTRIES } from "./workspace-manifest.js";
import {
  WORKSPACE_PATH_EXCLUSIONS_JS,
  WORKSPACE_STAGED_INPUT_OWNERSHIP_JS,
} from "./workspace-path-exclusions.js";
export { REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS } from "./workspace-accepted-remote-script.js";
export { REMOTE_GIT_WORKSPACE_RETRY_RESET_JS } from "./workspace-mutation-remote-script.js";
export { REMOTE_WORKSPACE_SETUP_SCRIPT } from "./workspace-sync-setup-script.js";

export const REMOTE_GIT_WORKSPACE_SETUP_SCRIPT = String.raw`set -eu
workspace=$1
pack=$2
base=$3
author_name=$4
author_email=$5
cd "$workspace"
if ! command -v git >/dev/null 2>&1; then
  printf '%s\n' 'git is required for a git worker workspace' >&2
  exit 2
fi
case ${"${"}#base} in
  40) git init -q . ;;
  64) git init -q --object-format=sha256 . ;;
  *) printf '%s\n' 'invalid worker git base object id' >&2; exit 2 ;;
esac
git index-pack --stdin < "$pack" >/dev/null
printf '%s\n' "$base" > .git/shallow
actual=$(git rev-parse --verify "$base^{commit}")
if [ "$actual" != "$base" ]; then
  printf '%s\n' 'worker git base does not match the synced pack' >&2
  exit 2
fi
git update-ref refs/heads/openclaw-worker "$base"
git symbolic-ref HEAD refs/heads/openclaw-worker
git read-tree "$base"
git ls-files --stage -z | node -e '
const childProcess = require("node:child_process");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const paths = Buffer.concat(chunks)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const separator = record.indexOf("\t");
      return separator >= 0 && record.startsWith("160000 ") ? [record.slice(separator + 1)] : [];
    });
  if (paths.length > 0) {
    childProcess.execFileSync("git", ["update-index", "--skip-worktree", "--", ...paths]);
  }
});'
rm -f -- "$pack"
if [ -n "$author_name" ]; then git config user.name "$author_name"; fi
if [ -n "$author_email" ]; then git config user.email "$author_email"; fi
`;

export const REMOTE_WORKSPACE_MANIFEST_JS = String.raw`const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
${WORKSPACE_PATH_EXCLUSIONS_JS}
const workspaceStatIdentity = ${workspaceStatIdentity.toString()};
const selectWorkerWorkspaceHashMemoEntries = ${selectWorkerWorkspaceHashMemoEntries.toString()};
const MAX_RECONCILIATION_ENTRIES = ${MAX_RECONCILIATION_ENTRIES};
const MAX_WORKSPACE_HASH_MEMO_BYTES = ${MAX_WORKSPACE_HASH_MEMO_BYTES};
const root = fs.realpathSync(process.argv[1]);
${WORKSPACE_STAGED_INPUT_OWNERSHIP_JS}
const requestedBaseCommit = process.argv[2] || null;
const eligibleOnly = process.argv[3] === "eligible";
const requestedManifestDigest = process.argv[3] === "resolve" ? process.argv[4] : null;
const publishedManifestDigest = process.argv[3] === "publish" ? process.argv[4] : null;
const memoMode = process.argv.at(-1) === "memo-v1";
const priorManifestDigests = [
  ...new Set(process.argv.slice(4).filter((value) => value && value !== "memo-v1")),
];
const MAX_WORKSPACE_GIT_CANDIDATES = ${MAX_WORKSPACE_GIT_CANDIDATES};
const MAX_WORKSPACE_INVENTORY_ENTRIES = ${MAX_WORKSPACE_INVENTORY_ENTRIES};
const MAX_WORKSPACE_INVENTORY_PATH_BYTES = ${MAX_WORKSPACE_INVENTORY_PATH_BYTES};
const MAX_WORKSPACE_INVENTORY_TOTAL_BYTES = ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES};
const MAX_WORKSPACE_MANIFEST_BYTES = ${MAX_WORKSPACE_MANIFEST_BYTES};
const entriesByPath = new Map();
let inventoryPathBytes = 0;
let eligibleBytes = 0;
const usedHashMemo = new Map();
const metrics = {
  contentHashCount: 0,
  contentHashDurationMs: 0,
  memoHitCount: 0,
  memoTruncatedCount: 0,
};
const startedAt = performance.now();
function fail(message) {
  throw new Error(message);
}
function readHashMemo() {
  if (!memoMode) return new Map();
  const raw = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > MAX_WORKSPACE_HASH_MEMO_BYTES) {
    fail("workspace hash memo exceeds its byte limit");
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    fail("invalid workspace hash memo");
  }
  if (
    !Array.isArray(entries) ||
    entries.length > MAX_RECONCILIATION_ENTRIES
  ) {
    fail("invalid workspace hash memo");
  }
  return new Map(entries);
}
const hashMemo = readHashMemo();
${REMOTE_WORKSPACE_MANIFEST_CANONICAL_JS}
function recordEntry(relative, entry) {
  if (entriesByPath.has(relative)) return;
  if (entriesByPath.size + 1 > MAX_WORKSPACE_INVENTORY_ENTRIES) {
    fail("worker workspace manifest has too many entries");
  }
  inventoryPathBytes += Buffer.byteLength(relative);
  if (inventoryPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
    fail("worker workspace manifest paths exceed their byte limit");
  }
  eligibleBytes +=
    entry.type === "file"
      ? entry.size
      : entry.type === "symlink"
        ? Buffer.byteLength(entry.target)
        : 0;
  if (eligibleBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
    fail("worker workspace manifest exceeds its eligible byte limit");
  }
  entriesByPath.set(relative, entry);
}
function addEntry(relative) {
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    fail("unsafe worker workspace path: " + relative);
  }
  if (isDerivedWorkspacePath(relative, isStagedInput(relative))) return;
  if (entriesByPath.has(relative)) return;
  const absolute = path.join(root, relative);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
    throw error;
  }
  const mode = stats.mode & 0o777;
  if (stats.isDirectory()) {
    recordEntry(relative, { path: relative, type: "directory", mode });
  } else if (stats.isFile()) {
    recordEntry(relative, { path: relative, type: "file", mode, size: stats.size, sha256: null });
  } else if (stats.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    if (target.includes("\\") || path.posix.isAbsolute(target) || path.win32.parse(target).root) {
      fail("worker workspace symlink must be portable and relative: " + relative);
    }
    const resolvedTarget = path.resolve(path.dirname(absolute), target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) {
      fail("worker workspace symlink escapes the sync root: " + relative);
    }
    recordEntry(relative, { path: relative, type: "symlink", mode, target });
  } else {
    fail("unsupported worker workspace entry: " + relative);
  }
}
function addWithParents(relative) {
  if (isDerivedWorkspacePath(relative, isStagedInput(relative))) return;
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    addEntry(segments.slice(0, index).join("/"));
  }
  addEntry(relative);
}
function walk(relativeDirectory) {
  const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  const names = [];
  const directory = fs.opendirSync(absoluteDirectory);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      if ((!relativeDirectory && entry.name === ".git") || isDerivedWorkspacePath(relative, isStagedInput(relative))) {
        continue;
      }
      names.push(entry.name);
      if (names.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
        fail("worker workspace directory has too many entries");
      }
    }
  } finally {
    directory.closeSync();
  }
  for (const name of names.sort()) {
    const relative = relativeDirectory ? relativeDirectory + "/" + name : name;
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      recordEntry(relative, { path: relative, type: "directory", mode });
      walk(relative);
    } else if (stats.isFile()) {
      recordEntry(relative, {
        path: relative,
        type: "file",
        mode,
        size: stats.size,
        sha256: null,
      });
    } else if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (target.includes("\\") || path.posix.isAbsolute(target) || path.win32.parse(target).root) {
        fail("worker workspace symlink must be portable and relative: " + relative);
      }
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) {
        fail("worker workspace symlink escapes the sync root: " + relative);
      }
      recordEntry(relative, { path: relative, type: "symlink", mode, target });
    } else {
      fail("unsupported worker workspace entry: " + relative);
    }
  }
}
function nulPaths(args) {
  const value = childProcess.execFileSync("git", ["-C", root, "ls-files", "-z", ...args], {
    encoding: "buffer",
    maxBuffer: MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  });
  const paths = value.toString("utf8").split("\0").filter(Boolean);
  if (paths.length > MAX_WORKSPACE_GIT_CANDIDATES) {
    fail("worker workspace has too many Git path candidates");
  }
  return paths;
}
function eligiblePaths() {
  const selected = new Set();
  let selectedPathBytes = 0;
  function addSelected(relative) {
    if (selected.has(relative)) return;
    if (selected.size + 1 > MAX_WORKSPACE_GIT_CANDIDATES) {
      fail("worker workspace has too many Git path candidates");
    }
    selectedPathBytes += Buffer.byteLength(relative) + 1;
    if (selectedPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      fail("worker workspace Git path candidates exceed their byte limit");
    }
    selected.add(relative);
  }
  function removeSelected(relative) {
    if (!selected.delete(relative)) return;
    selectedPathBytes -= Buffer.byteLength(relative) + 1;
  }
  for (const relative of nulPaths(["--full-name", "--cached", "--others", "--exclude-standard"])) {
    addSelected(relative);
  }
  removeSelected(".openclaw-base.pack");
  const includePath = path.join(root, ".worktreeinclude");
  const hasIncludes = fs.existsSync(includePath) && fs.lstatSync(includePath).isFile();
  const ignored = new Set(nulPaths(["--full-name", "--others", "--ignored", "--exclude-standard",
    ...(hasIncludes ? [] : ["--", ${JSON.stringify(STAGED_INPUT_GIT_PATHSPEC)}]),
  ]));
  for (const candidate of ignored) {
    if (isStagedInput(candidate)) addSelected(candidate);
  }
  if (hasIncludes) {
    // Keep standard excludes out of this query. Their union would select every
    // ignored path instead of only explicit .worktreeinclude matches.
    for (const candidate of nulPaths([
      "--full-name",
      "--others",
      "--ignored",
      "--exclude-from=" + includePath,
    ])) {
      if (ignored.has(candidate)) addSelected(candidate);
    }
  }
  for (const priorManifestDigest of priorManifestDigests) {
    if (!/^[a-f0-9]{64}$/.test(priorManifestDigest)) fail("invalid prior workspace manifest digest");
    const priorPath = path.join(process.env.HOME, ".openclaw-worker", "manifests", priorManifestDigest + ".json");
    const priorRaw = readManifestFile(priorPath);
    if (crypto.createHash("sha256").update(priorRaw).digest("hex") !== priorManifestDigest) {
      fail("prior workspace manifest digest mismatch");
    }
    const prior = JSON.parse(priorRaw);
    if (
      !prior ||
      prior.version !== 1 ||
      !Array.isArray(prior.entries) ||
      prior.entries.length > MAX_WORKSPACE_INVENTORY_ENTRIES
    ) {
      fail("invalid prior workspace manifest");
    }
    for (const entry of prior.entries) {
      if (!entry || typeof entry.path !== "string") fail("invalid prior workspace manifest entry");
      if (entry.path !== ".openclaw-base.pack" && !isDerivedWorkspacePath(entry.path, isStagedInput(entry.path))) {
        addSelected(entry.path);
      }
    }
  }
  const paths = [...selected].filter((relative) => !isDerivedWorkspacePath(relative, isStagedInput(relative))).sort();
  if (paths.length > MAX_WORKSPACE_GIT_CANDIDATES) {
    fail("worker workspace has too many Git path candidates");
  }
  let pathBytes = 0;
  for (const relative of paths) {
    pathBytes += Buffer.byteLength(relative) + 1;
    if (pathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      fail("worker workspace eligible paths exceed their byte limit");
    }
  }
  return paths;
}
function assertSerializedManifestBudget(baseCommit, entries) {
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, baseCommit, entries: [] }));
  for (const [index, entry] of entries.entries()) {
    const projected =
      entry.type === "file" ? { ...entry, sha256: "0".repeat(64) } : entry;
    bytes += Buffer.byteLength(JSON.stringify(canonicalEntry(projected)));
    if (index > 0) bytes += 1;
    if (bytes > MAX_WORKSPACE_MANIFEST_BYTES) {
      fail("worker workspace manifest exceeds its serialized byte limit");
    }
  }
}
async function hashFiles(entries) {
  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }
    const absolute = path.join(root, entry.path);
    const handle = await fs.promises.open(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) fail("worker workspace file changed while it was being read");
      const identity = workspaceStatIdentity("worker", before);
      let sha256 = hashMemo.get(identity);
      if (sha256) {
        metrics.memoHitCount += 1;
      } else {
        const hashStartedAt = performance.now();
        const hash = crypto.createHash("sha256");
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) {
          hash.update(chunk);
        }
        sha256 = hash.digest("hex");
        metrics.contentHashCount += 1;
        metrics.contentHashDurationMs += performance.now() - hashStartedAt;
      }
      const after = await handle.stat({ bigint: true });
      if (workspaceStatIdentity("worker", after) !== identity) {
        fail("worker workspace file changed while it was being read");
      }
      entry.mode = Number(after.mode & 0o777n);
      entry.size = Number(after.size);
      entry.sha256 = sha256;
      usedHashMemo.set(identity, sha256);
    } finally {
      await handle.close();
    }
  }
}
function ensurePrivateDirectory(directory) {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail("unsafe worker manifest directory");
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fs.mkdirSync(directory, { mode: 0o700 });
    } else {
      throw error;
    }
  }
  fs.chmodSync(directory, 0o700);
}
${REMOTE_WORKSPACE_MANIFEST_REGISTRY_JS}
async function readPublishedManifest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_WORKSPACE_MANIFEST_BYTES) {
      fail("published workspace manifest exceeds its byte limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function preserveWindowsFileModes(entries, manifestRoot) {
  if (process.platform !== "win32" || priorManifestDigests.length === 0) return;
  const modes = new Map();
  for (const digest of priorManifestDigests) {
    if (!/^[a-f0-9]{64}$/.test(digest)) fail("invalid prior workspace manifest digest");
    const raw = readManifestFile(path.join(manifestRoot, digest + ".json"));
    if (crypto.createHash("sha256").update(raw).digest("hex") !== digest) {
      fail("prior workspace manifest digest mismatch");
    }
    const prior = JSON.parse(raw);
    if (
      !prior ||
      prior.version !== 1 ||
      !Array.isArray(prior.entries) ||
      prior.entries.length > MAX_WORKSPACE_INVENTORY_ENTRIES
    ) {
      fail("invalid prior workspace manifest");
    }
    for (const entry of prior.entries) {
      if (entry.type === "file" && !modes.has(entry.path)) {
        if (entry.mode !== 0o644 && entry.mode !== 0o755) {
          fail("invalid prior workspace file mode");
        }
        modes.set(entry.path, entry.mode);
      }
    }
  }
  // Windows cannot persist POSIX execute bits; the authenticated prior manifest owns them.
  for (const entry of entries) {
    if (entry.type === "file" && modes.has(entry.path)) entry.mode = modes.get(entry.path);
  }
}
async function main() {
  const workerRoot = path.join(process.env.HOME, ".openclaw-worker");
  const manifestRoot = path.join(workerRoot, "manifests");
  ensurePrivateDirectory(workerRoot);
  ensurePrivateDirectory(manifestRoot);
  if (publishedManifestDigest) {
    const manifest = await readPublishedManifest();
    if (crypto.createHash("sha256").update(manifest).digest("hex") !== publishedManifestDigest) {
      fail("published workspace manifest digest mismatch");
    }
    if (publishManifest(manifestRoot, manifest) !== publishedManifestDigest) {
      fail("published workspace manifest reference mismatch");
    }
    process.stdout.write("sha256:" + publishedManifestDigest + "\n");
    return;
  }
  if (requestedManifestDigest) {
    process.stdout.write("sha256:" + resolveManifest(manifestRoot, requestedManifestDigest) + "\n");
    return;
  }
  if (eligibleOnly) {
    for (const relative of eligiblePaths()) addWithParents(relative);
  } else {
    walk("");
  }
  const entries = [...entriesByPath.values()];
  assertSerializedManifestBudget(requestedBaseCommit, entries);
  await hashFiles(entries);
  preserveWindowsFileModes(entries, manifestRoot);
  const baseCommit = requestedBaseCommit;
  const manifest = serializeManifest(baseCommit, entries);
  const digest = publishManifest(manifestRoot, manifest);
  const manifestRef = "sha256:" + digest;
  if (memoMode) {
    const memo = selectWorkerWorkspaceHashMemoEntries(
      usedHashMemo, MAX_RECONCILIATION_ENTRIES, MAX_WORKSPACE_HASH_MEMO_BYTES,
    );
    metrics.memoTruncatedCount = usedHashMemo.size - memo.length;
    const measured = { ...metrics, totalDurationMs: performance.now() - startedAt };
    process.stdout.write(JSON.stringify({
      version: 1,
      manifestRef,
      memo,
      metrics: measured,
    }) + "\n");
  } else {
    process.stdout.write(manifestRef + "\n");
  }
}
main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});`;
