export const REMOTE_WORKSPACE_SETUP_SCRIPT = String.raw`set -eu
relative=$1
root=$HOME/.openclaw-worker

ensure_private_directory() {
  directory=$1
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      printf '%s\n' 'unsafe worker workspace directory' >&2
      exit 2
    fi
  else
    mkdir "$directory"
  fi
  chmod 700 "$directory"
}

ensure_private_directory "$root"
current=$root
old_ifs=$IFS
IFS=/
set -- $relative
IFS=$old_ifs
for segment in "$@"; do
  current=$current/$segment
  ensure_private_directory "$current"
done
cd "$current"
find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
pwd -P
`;

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
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const baseCommit = process.argv[2] || null;
const entries = [];
function fail(message) {
  throw new Error(message);
}
function walk(relativeDirectory) {
  const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  for (const name of fs.readdirSync(absoluteDirectory).sort()) {
    if (!relativeDirectory && name === ".git") {
      continue;
    }
    const relative = relativeDirectory ? relativeDirectory + "/" + name : name;
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode });
      walk(relative);
    } else if (stats.isFile()) {
      entries.push({
        path: relative,
        type: "file",
        mode,
        size: stats.size,
        sha256: null,
      });
    } else if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) {
        fail("worker workspace symlink escapes the sync root: " + relative);
      }
      entries.push({ path: relative, type: "symlink", mode, target });
    } else {
      fail("unsupported worker workspace entry: " + relative);
    }
  }
}
async function hashFiles() {
  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(path.join(root, entry.path));
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    entry.sha256 = hash.digest("hex");
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
async function main() {
  walk("");
  await hashFiles();
  const manifest = JSON.stringify({ version: 1, baseCommit, entries });
  const digest = crypto.createHash("sha256").update(manifest).digest("hex");
  const workerRoot = path.join(process.env.HOME, ".openclaw-worker");
  const manifestRoot = path.join(workerRoot, "manifests");
  ensurePrivateDirectory(workerRoot);
  ensurePrivateDirectory(manifestRoot);
  const manifestPath = path.join(manifestRoot, digest + ".json");
  const temporaryPath = manifestPath + "." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temporaryPath, manifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    try {
      fs.linkSync(temporaryPath, manifestPath);
    } catch (error) {
      const existing = error && error.code === "EEXIST" ? fs.lstatSync(manifestPath) : null;
      if (
        !existing ||
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        fs.readFileSync(manifestPath, "utf8") !== manifest
      ) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  process.stdout.write("sha256:" + digest + "\n");
}
main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});`;
