import {
  REMOTE_WORKSPACE_MANIFEST_CANONICAL_JS,
  REMOTE_WORKSPACE_MANIFEST_REGISTRY_JS,
} from "./workspace-manifest-remote-script.js";
export { REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS } from "./workspace-manifest-remote-script.js";
import {
  DERIVED_WORKSPACE_DIRECTORY_NAMES,
  DERIVED_WORKSPACE_FILE_NAMES,
  DERIVED_WORKSPACE_FILE_SUFFIXES,
  isDerivedWorkspacePath,
} from "./workspace-path-exclusions.js";
export { REMOTE_WORKSPACE_SETUP_SCRIPT } from "./workspace-sync-setup-script.js";

export const REMOTE_WORKSPACE_QUIESCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (uid === 0) throw new Error("workspace quiescence refuses root-owned worker sessions");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const leaseDirectory = path.join(os.homedir(), ".openclaw-worker", "quiescence");
fs.mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(leaseDirectory, 0o700);
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const nonce = crypto.randomBytes(16).toString("hex");
const leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
const watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
function processes() {
  const output = childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      uid: Number(match[3]),
      state: match[4],
      start: match[5],
    });
  }
  return rows;
}
function ancestors(rows) {
  const result = new Set();
  let pid = process.pid;
  while (pid > 0 && !result.has(pid)) {
    result.add(pid);
    pid = rows.get(pid)?.ppid || 0;
  }
  return result;
}
const frozen = new Map();
let watchdogReference = null;
function processIdentity(pid) {
  try {
    const start = childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 4096,
    }).trim();
    return start || null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function validProcessReference(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === "string" && value.start.length > 0 && value.start.length <= 128;
}
function parseLease(raw, expectedNonce) {
  const lease = JSON.parse(raw);
  if (
    !lease ||
    lease.version !== 1 ||
    lease.nonce !== expectedNonce ||
    !Array.isArray(lease.processes) ||
    lease.processes.length > 4096 ||
    lease.processes.some((entry) => !validProcessReference(entry)) ||
    (lease.watchdog !== null && !validProcessReference(lease.watchdog)) ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs < 1
  ) {
    throw new Error("invalid workspace quiescence lease");
  }
  return lease;
}
function persistLease(expiresAtMs = Date.now() + watchdogTimeoutMs) {
  const temporary = leasePath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  const processes = [...frozen].map(([pid, start]) => ({ pid, start }));
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, nonce, processes, watchdog: watchdogReference, expiresAtMs }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, leasePath);
}
function resumeProcesses(entries) {
  for (const entry of entries) {
    if (processIdentity(entry.pid) !== entry.start) continue;
    try {
      process.kill(entry.pid, "SIGCONT");
    } catch (error) {
      if (!error || error.code !== "ESRCH") throw error;
    }
  }
}
const orphanNames = fs.readdirSync(leaseDirectory).filter((name) =>
  name.startsWith(workspaceKey + ".") && name.endsWith(".json"),
);
if (orphanNames.length > 16) throw new Error("too many workspace quiescence leases");
for (const name of orphanNames) {
  const match = name.match(/^[a-f0-9]{64}\.([a-f0-9]{32})\.json$/);
  if (!match) continue;
  const orphanPath = path.join(leaseDirectory, name);
  const lease = parseLease(fs.readFileSync(orphanPath, "utf8"), match[1]);
  if (lease.watchdog !== null && processIdentity(lease.watchdog.pid) === lease.watchdog.start) {
    try { process.kill(lease.watchdog.pid, "SIGTERM"); } catch (error) { if (!error || error.code !== "ESRCH") throw error; }
  }
  resumeProcesses(lease.processes);
  fs.unlinkSync(orphanPath);
}
persistLease();
const watchdog = childProcess.spawn(
  process.execPath,
  ["-e", "(" + watchdogMain.toString() + ")(process.argv[1], process.argv[2])", leasePath, nonce],
  { detached: true, stdio: "ignore" },
);
watchdog.unref();
if (!Number.isSafeInteger(watchdog.pid) || watchdog.pid < 1) {
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog did not start");
}
let watchdogStart = null;
for (let attempt = 0; attempt < 100 && !watchdogStart; attempt += 1) {
  watchdogStart = processIdentity(watchdog.pid);
  if (!watchdogStart) Atomics.wait(sleeper, 0, 0, 10);
}
if (!watchdogStart) {
  try { process.kill(watchdog.pid, "SIGTERM"); } catch {}
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog identity was not observable");
}
watchdogReference = { pid: watchdog.pid, start: watchdogStart };
persistLease();
let quietScans = 0;
try {
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const before = processes();
    const preserved = ancestors(before);
    const candidates = [...before.entries()].filter(
      ([pid, row]) =>
        row.uid === uid &&
        !preserved.has(pid) &&
        row.ppid !== process.pid &&
        pid !== watchdog.pid &&
        !frozen.has(pid) &&
        !row.state.startsWith("T") &&
        !row.state.startsWith("Z") &&
        !row.state.startsWith("X"),
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    for (const [pid, row] of candidates) {
      try {
        frozen.set(pid, row.start);
        persistLease();
        if (processIdentity(pid) !== row.start) {
          frozen.delete(pid);
          persistLease();
          continue;
        }
        process.kill(pid, "SIGSTOP");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw error;
      }
    }
    Atomics.wait(sleeper, 0, 0, 20);
    const after = processes();
    const afterPreserved = ancestors(after);
    const writable = [...after.entries()].some(
      ([pid, row]) =>
        row.uid === uid &&
        !afterPreserved.has(pid) &&
        row.ppid !== process.pid &&
        pid !== watchdog.pid &&
        !row.state.startsWith("T") &&
        !row.state.startsWith("Z") &&
        !row.state.startsWith("X"),
    );
    quietScans = writable ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not reach a quiescent state");
  }
} catch (error) {
  if (processIdentity(watchdog.pid) === watchdogStart) {
    try { process.kill(watchdog.pid, "SIGTERM"); } catch (killError) { if (!killError || killError.code !== "ESRCH") throw killError; }
  }
  resumeProcesses([...frozen].map(([pid, start]) => ({ pid, start })));
  try { fs.unlinkSync(leasePath); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError; }
  throw error;
}
function watchdogMain(watchedLeasePath, watchedNonce) {
  const check = () => {
    try {
      const watchdogFs = require("node:fs");
      const lease = JSON.parse(watchdogFs.readFileSync(watchedLeasePath, "utf8"));
      if (
        !lease ||
        lease.version !== 1 ||
        lease.nonce !== watchedNonce ||
        !Array.isArray(lease.processes) ||
        !Number.isSafeInteger(lease.expiresAtMs)
      ) return;
      const remainingMs = lease.expiresAtMs - Date.now();
      if (remainingMs > 0) {
        setTimeout(check, Math.min(remainingMs, 60 * 1000));
        return;
      }
      // Re-read at expiry so a renewal that raced this wake-up wins before SIGCONT.
      const latest = JSON.parse(watchdogFs.readFileSync(watchedLeasePath, "utf8"));
      if (
        latest &&
        latest.version === 1 &&
        latest.nonce === watchedNonce &&
        Array.isArray(latest.processes) &&
        Number.isSafeInteger(latest.expiresAtMs) &&
        latest.expiresAtMs > Date.now()
      ) {
        setTimeout(check, Math.min(latest.expiresAtMs - Date.now(), 60 * 1000));
        return;
      }
      const watchdogChildProcess = require("node:child_process");
      const identity = (pid) => {
        try {
          return watchdogChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096 }).trim() || null;
        } catch (error) {
          if (error && error.status === 1) return null;
          throw error;
        }
      };
      for (const entry of lease.processes) {
        if (
          !entry ||
          !Number.isSafeInteger(entry.pid) ||
          entry.pid < 1 ||
          typeof entry.start !== "string" ||
          identity(entry.pid) !== entry.start
        ) continue;
        try { process.kill(entry.pid, "SIGCONT"); } catch (error) { if (!error || error.code !== "ESRCH") throw error; }
      }
      watchdogFs.unlinkSync(watchedLeasePath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") process.exitCode = 1;
    }
  };
  check();
}
process.stdout.write("quiesced " + nonce + "\n");
`;

export const REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
const timeoutMs = Number(process.argv[3] || 12 * 60 * 1000);
const validationMode = process.argv[4] || "final";
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 1000) throw new Error("invalid watchdog timeout");
if (validationMode !== "heartbeat" && validationMode !== "final") throw new Error("invalid workspace quiescence validation mode");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
const input = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (
  !input ||
  input.version !== 1 ||
  input.nonce !== nonce ||
  !Array.isArray(input.processes) ||
  input.processes.length > 4096 ||
  input.processes.some((entry) => !entry || !Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.start !== "string" || !entry.start || entry.start.length > 128) ||
  !input.watchdog ||
  !Number.isSafeInteger(input.watchdog.pid) ||
  input.watchdog.pid < 1 ||
  typeof input.watchdog.start !== "string" ||
  !input.watchdog.start ||
  input.watchdog.start.length > 128 ||
  !Number.isSafeInteger(input.expiresAtMs) ||
  input.expiresAtMs - Date.now() < 5000
) {
  throw new Error("workspace quiescence lease is no longer active");
}
function processStatus(pid) {
  try {
    const output = childProcess.execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096 }).trim();
    const match = /^(\S+)\s+(.+)$/u.exec(output);
    return match ? { state: match[1], start: match[2] } : null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function processes() {
  const output = childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      uid: Number(match[3]),
      state: match[4],
      start: match[5],
    });
  }
  return rows;
}
function ancestors(rows) {
  const result = new Set();
  let pid = process.pid;
  while (pid > 0 && !result.has(pid)) {
    result.add(pid);
    pid = rows.get(pid)?.ppid || 0;
  }
  return result;
}
for (const entry of input.processes) {
  const status = processStatus(entry.pid);
  if (!status || status.start !== entry.start) continue;
  const state = status.state;
  if (state && !state.startsWith("T")) throw new Error("workspace quiescence process resumed unexpectedly");
}
const watchdogStatus = processStatus(input.watchdog.pid);
if (!watchdogStatus || watchdogStatus.start !== input.watchdog.start) {
  throw new Error("workspace quiescence watchdog identity changed unexpectedly");
}
try { process.kill(input.watchdog.pid, 0); } catch (error) {
  if (error && error.code === "ESRCH") throw new Error("workspace quiescence watchdog exited unexpectedly");
  throw error;
}
if (validationMode === "final") {
  const rows = processes();
  const preserved = ancestors(rows);
  const frozen = new Map(input.processes.map((entry) => [entry.pid, entry.start]));
  const newWritableProcess = [...rows.entries()].some(
    ([pid, row]) =>
      row.uid === uid &&
      !preserved.has(pid) &&
      row.ppid !== process.pid &&
      pid !== input.watchdog.pid &&
      frozen.get(pid) !== row.start &&
      !row.state.startsWith("T") &&
      !row.state.startsWith("Z") &&
      !row.state.startsWith("X"),
  );
  if (newWritableProcess) {
    throw new Error("workspace quiescence observed a new writable process");
  }
}
const renewed = { ...input, expiresAtMs: Date.now() + timeoutMs };
const temporary = leasePath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
fs.writeFileSync(temporary, JSON.stringify(renewed), { mode: 0o600, flag: "wx" });
fs.renameSync(temporary, leasePath);
const confirmed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (confirmed.nonce !== nonce || confirmed.expiresAtMs !== renewed.expiresAtMs) {
  throw new Error("workspace quiescence renewal was not durable");
}
process.stdout.write("renewed " + nonce + "\n");
`;

export const REMOTE_WORKSPACE_RESUME_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
let raw;
try { raw = fs.readFileSync(leasePath, "utf8"); } catch (error) {
  if (error && error.code === "ENOENT") process.exit(0);
  throw error;
}
const input = JSON.parse(raw);
if (
  !input ||
  input.version !== 1 ||
  input.nonce !== nonce ||
  !Array.isArray(input.processes) ||
  input.processes.length > 4096 ||
  input.processes.some((entry) => !entry || !Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.start !== "string" || !entry.start || entry.start.length > 128) ||
  (input.watchdog !== null && (!input.watchdog || !Number.isSafeInteger(input.watchdog.pid) || input.watchdog.pid < 1 || typeof input.watchdog.start !== "string" || !input.watchdog.start || input.watchdog.start.length > 128)) ||
  !Number.isSafeInteger(input.expiresAtMs) ||
  input.expiresAtMs < 1
) {
  throw new Error("invalid workspace quiescence lease");
}
function identity(pid) {
  try {
    return require("node:child_process").execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096 }).trim() || null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
if (input.watchdog !== null && identity(input.watchdog.pid) === input.watchdog.start) {
  try { process.kill(input.watchdog.pid, "SIGTERM"); } catch (error) { if (!error || error.code !== "ESRCH") throw error; }
}
for (const entry of input.processes) {
  if (identity(entry.pid) !== entry.start) continue;
  try { process.kill(entry.pid, "SIGCONT"); } catch (error) { if (!error || error.code !== "ESRCH") throw error; }
}
fs.unlinkSync(leasePath);
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
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const DERIVED_WORKSPACE_DIRECTORY_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_DIRECTORY_NAMES)};
const DERIVED_WORKSPACE_FILE_NAMES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_NAMES)};
const DERIVED_WORKSPACE_FILE_SUFFIXES = ${JSON.stringify(DERIVED_WORKSPACE_FILE_SUFFIXES)};
const isDerivedWorkspacePath = ${isDerivedWorkspacePath.toString()};
const root = fs.realpathSync(process.argv[1]);
const requestedBaseCommit = process.argv[2] || null;
const eligibleOnly = process.argv[3] === "eligible";
const requestedManifestDigest = process.argv[3] === "resolve" ? process.argv[4] : null;
const publishedManifestDigest = process.argv[3] === "publish" ? process.argv[4] : null;
const legacyGatewayLocale = requestedManifestDigest ? process.argv[5] : null;
const priorManifestDigests = [...new Set(process.argv.slice(4).filter(Boolean))];
const entriesByPath = new Map();
function fail(message) {
  throw new Error(message);
}
${REMOTE_WORKSPACE_MANIFEST_CANONICAL_JS}
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
  if (isDerivedWorkspacePath(relative)) return;
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
    entriesByPath.set(relative, { path: relative, type: "directory", mode });
  } else if (stats.isFile()) {
    entriesByPath.set(relative, { path: relative, type: "file", mode, size: stats.size, sha256: null });
  } else if (stats.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    if (target.includes("\\") || path.posix.isAbsolute(target) || path.win32.parse(target).root) {
      fail("worker workspace symlink must be portable and relative: " + relative);
    }
    const resolvedTarget = path.resolve(path.dirname(absolute), target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) {
      fail("worker workspace symlink escapes the sync root: " + relative);
    }
    entriesByPath.set(relative, { path: relative, type: "symlink", mode, target });
  } else {
    fail("unsupported worker workspace entry: " + relative);
  }
}
function addWithParents(relative) {
  if (isDerivedWorkspacePath(relative)) return;
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    addEntry(segments.slice(0, index).join("/"));
  }
  addEntry(relative);
}
function walk(relativeDirectory) {
  const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  for (const name of fs.readdirSync(absoluteDirectory).sort()) {
    if (!relativeDirectory && name === ".git") {
      continue;
    }
    const relative = relativeDirectory ? relativeDirectory + "/" + name : name;
    if (isDerivedWorkspacePath(relative)) continue;
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      entriesByPath.set(relative, { path: relative, type: "directory", mode });
      walk(relative);
    } else if (stats.isFile()) {
      entriesByPath.set(relative, {
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
      entriesByPath.set(relative, { path: relative, type: "symlink", mode, target });
    } else {
      fail("unsupported worker workspace entry: " + relative);
    }
  }
}
function nulPaths(args) {
  const value = childProcess.execFileSync("git", ["-C", root, "ls-files", ...args, "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return value.toString("utf8").split("\0").filter(Boolean);
}
function eligiblePaths() {
  const selected = new Set(nulPaths(["--full-name", "--cached", "--others", "--exclude-standard"]));
  selected.delete(".openclaw-base.pack");
  const includePath = path.join(root, ".worktreeinclude");
  if (fs.existsSync(includePath) && fs.lstatSync(includePath).isFile()) {
    const ignored = new Set(nulPaths(["--full-name", "--others", "--ignored", "--exclude-standard"]));
    // Keep standard excludes out of this query. Their union would select every
    // ignored path instead of only explicit .worktreeinclude matches.
    for (const candidate of nulPaths([
      "--full-name",
      "--others",
      "--ignored",
      "--exclude-from=" + includePath,
    ])) {
      if (ignored.has(candidate)) selected.add(candidate);
    }
  }
  for (const priorManifestDigest of priorManifestDigests) {
    if (!/^[a-f0-9]{64}$/.test(priorManifestDigest)) fail("invalid prior workspace manifest digest");
    const priorPath = path.join(process.env.HOME, ".openclaw-worker", "manifests", priorManifestDigest + ".json");
    const priorRaw = fs.readFileSync(priorPath, "utf8");
    if (crypto.createHash("sha256").update(priorRaw).digest("hex") !== priorManifestDigest) {
      fail("prior workspace manifest digest mismatch");
    }
    const prior = JSON.parse(priorRaw);
    if (!prior || prior.version !== 1 || !Array.isArray(prior.entries)) {
      fail("invalid prior workspace manifest");
    }
    for (const entry of prior.entries) {
      if (!entry || typeof entry.path !== "string") fail("invalid prior workspace manifest entry");
      if (entry.path !== ".openclaw-base.pack" && !isDerivedWorkspacePath(entry.path)) {
        selected.add(entry.path);
      }
    }
  }
  return [...selected].filter((relative) => !isDerivedWorkspacePath(relative)).sort();
}
async function hashFiles() {
  const entries = [...entriesByPath.values()];
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
  return entries;
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
async function main() {
  const workerRoot = path.join(process.env.HOME, ".openclaw-worker");
  const manifestRoot = path.join(workerRoot, "manifests");
  ensurePrivateDirectory(workerRoot);
  ensurePrivateDirectory(manifestRoot);
  if (publishedManifestDigest) {
    const manifest = fs.readFileSync(0, "utf8");
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
  const entries = await hashFiles();
  const baseCommit = requestedBaseCommit;
  const manifest = serializeManifest(baseCommit, entries);
  const digest = publishManifest(manifestRoot, manifest);
  process.stdout.write("sha256:" + digest + "\n");
}
main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});`;
