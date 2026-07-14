import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  type WorkerAdmissionHandshake,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  validateWorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/index.js";
import { isExactSemverVersion } from "../../infra/npm-registry-spec.js";
import { normalizeScpRemotePath } from "../../infra/scp-host.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { WorkerSshEndpoint, WorkerSshIdentity } from "../../plugins/types.js";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";
import { WORKER_BUNDLE_MANIFEST_VERSION, type WorkerInstallationArtifact } from "./bundle.js";
import {
  prepareWorkerSsh,
  type PreparedWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";

const BOOTSTRAP_ROOT = ".openclaw-worker";
const BOOTSTRAP_RECEIPT = "bootstrap-receipt.json";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const NODE_MISSING_EXIT_CODE = 42;
const NPM_MISSING_EXIT_CODE = 43;
const LOCK_TIMEOUT_EXIT_CODE = 44;
const NODE_UNSUPPORTED_EXIT_CODE = 45;
const LOCK_MAX_AGE_SECONDS = 60 * 60;
const NODE_MISSING_MARKER = "OPENCLAW_WORKER_NODE_MISSING";
const NODE_UNSUPPORTED_MARKER = "OPENCLAW_WORKER_NODE_UNSUPPORTED";
const NPM_MISSING_MARKER = "OPENCLAW_WORKER_NPM_MISSING";
const BOOTSTRAP_OUTPUT_TAG = "OPENCLAW_WORKER_BOOTSTRAP_V1";
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NPM_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;

// Keep these boundaries aligned with package.json engines.node and infra/runtime-guard.ts.
const NODE_RUNTIME_CHECK_JS = String.raw`const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number); const atLeast = (version, floor) => version[0] > floor[0] || (version[0] === floor[0] && (version[1] > floor[1] || (version[1] === floor[1] && version[2] >= floor[2])));
const node = parse(process.versions.node); if (!node) process.exit(1);
const nodeSafe = (node[0] === 22 && atLeast(node, [22, 22, 3])) || (node[0] === 24 && atLeast(node, [24, 15, 0])) || (node[0] === 25 && atLeast(node, [25, 9, 0])) || node[0] >= 26;
if (!nodeSafe) process.exit(1);
try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:");
  const sqlite = parse(String(db.prepare("SELECT sqlite_version() AS version").get()?.version ?? ""));
  db.close(); if (!sqlite) process.exit(1);
  const sqliteSafe = atLeast(sqlite, [3, 51, 3]) || (sqlite[0] === 3 && ((sqlite[1] === 50 && sqlite[2] >= 7) || (sqlite[1] === 44 && sqlite[2] >= 6)));
  process.exit(sqliteSafe ? 0 : 1); } catch { process.exit(1); }`;

const RECEIPT_MATCH_JS = String.raw`const fs = require("node:fs");
try {
  const actual = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expected = JSON.parse(process.argv[2]);
  const shapeMatches =
    Object.keys(actual).sort().join(",") === "bundleHash,openclawVersion,protocolFeatures";
  const featuresMatch =
    Array.isArray(actual.protocolFeatures) &&
    Array.isArray(expected.protocolFeatures) &&
    actual.protocolFeatures.length === expected.protocolFeatures.length &&
    actual.protocolFeatures.every((feature, index) => feature === expected.protocolFeatures[index]);
  process.exit(
    shapeMatches &&
      actual.bundleHash === expected.bundleHash &&
      actual.openclawVersion === expected.openclawVersion &&
      featuresMatch
      ? 0
      : 1,
  );
} catch {
  process.exit(1);
}`;

const VERIFY_ARCHIVE_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
try {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
  process.exit(actual === process.argv[2] ? 0 : 1);
} catch {
  process.exit(1);
}`;

const VERIFY_NPM_PACKAGE_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
try {
  const actual = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64");
  process.exit(actual === process.argv[2] ? 0 : 1);
} catch {
  process.exit(1);
}`;

const READ_NPM_PACK_FILENAME_JS = String.raw`const fs = require("node:fs");
const path = require("node:path");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const filename = Array.isArray(value) && value.length === 1 ? value[0]?.filename : undefined;
  if (typeof filename !== "string" || !filename || path.basename(filename) !== filename) {
    process.exit(1);
  }
  process.stdout.write(filename);
} catch {
  process.exit(1);
}`;

// Recompute the gateway's canonical file manifest before a receipt can attest to it.
const VERIFY_INSTALL_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const expected = process.argv[2];
const install = process.argv[3];
const entries = [];
function fail(message) {
  throw new Error(message);
}
function assertRoot() {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe worker install root");
  }
  fs.chmodSync(root, 0o700);
}
function assertDirectory(relative) {
  const absolute = path.join(root, ...relative.split("/"));
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe worker directory: " + relative);
  }
  fs.chmodSync(absolute, 0o700);
}
function addFile(relative) {
  const parts = relative.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    assertDirectory(parts.slice(0, index).join("/"));
  }
  const absolute = path.join(root, ...relative.split("/"));
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("unsafe worker file: " + relative);
  }
  const contents = fs.readFileSync(absolute);
  const mode = relative === "openclaw.mjs" || (stats.mode & 0o111) !== 0 ? 0o700 : 0o600;
  fs.chmodSync(absolute, mode);
  entries.push({
    path: relative,
    mode,
    size: contents.byteLength,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  });
}
function walk(relativeDirectory) {
  assertDirectory(relativeDirectory);
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/"));
  for (const name of fs.readdirSync(absoluteDirectory).sort()) {
    const relative = relativeDirectory + "/" + name;
    const stats = fs.lstatSync(path.join(root, ...relative.split("/")));
    if (stats.isSymbolicLink()) {
      fail("unsafe worker path: " + relative);
    }
    if (stats.isDirectory()) {
      walk(relative);
    } else {
      addFile(relative);
    }
  }
}
function readNpmInventory() {
  assertDirectory("dist");
  const inventoryPath = path.join(root, "dist", "postinstall-inventory.json");
  const inventoryStats = fs.lstatSync(inventoryPath);
  if (inventoryStats.isSymbolicLink() || !inventoryStats.isFile()) {
    fail("unsafe worker dist inventory");
  }
  const value = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail("invalid worker dist inventory");
  }
  const unique = new Set(value);
  if (unique.size !== value.length) {
    fail("duplicate worker dist inventory entry");
  }
  for (const relative of value) {
    if (
      !relative.startsWith("dist/") ||
      relative.includes("\\") ||
      path.posix.normalize(relative) !== relative ||
      relative === "dist/postinstall-inventory.json"
    ) {
      fail("unsafe worker dist inventory entry: " + relative);
    }
    addFile(relative);
  }
}
try {
  assertRoot();
  addFile("openclaw.mjs");
  addFile("package.json");
  if (install === "npm") {
    readNpmInventory();
  } else if (install === "bundle") {
    walk("dist");
    // Vendored workspace packages ship inside the bundle and are part of its hash;
    // node_modules is installed after verification and never walked here.
    const vendorPath = path.join(root, "vendor");
    const vendorStats = fs.existsSync(vendorPath) ? fs.lstatSync(vendorPath) : undefined;
    if (vendorStats) {
      if (vendorStats.isSymbolicLink() || !vendorStats.isDirectory()) {
        fail("unsafe worker vendor directory");
      }
      walk("vendor");
    }
  } else {
    fail("invalid worker install channel");
  }
  if (entries.length < 3) {
    fail("worker dist is empty");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const separator = String.fromCharCode(0);
  const hash = crypto.createHash("sha256");
  hash.update("${WORKER_BUNDLE_MANIFEST_VERSION}" + separator);
  for (const entry of entries) {
    hash.update(entry.path + separator + entry.mode.toString(8) + separator + entry.size + separator + entry.sha256 + separator);
  }
  process.exit(hash.digest("hex") === expected ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}`;

const PREFLIGHT_SCRIPT = String.raw`set -eu
umask 077
hash=$1
expected_receipt=$2
install=$3
root=$HOME/${BOOTSTRAP_ROOT}
install_dir=$root/$hash
receipt=$install_dir/${BOOTSTRAP_RECEIPT}

ensure_private_directory() {
  directory=$1
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      printf '%s\n' 'unsafe worker bootstrap directory' >&2
      exit 2
    fi
  else
    mkdir "$directory"
  fi
  chmod 700 "$directory"
}

ensure_private_directory "$root"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '${NODE_MISSING_MARKER}' >&2
  exit ${NODE_MISSING_EXIT_CODE}
fi

if ! node -e '${NODE_RUNTIME_CHECK_JS}'; then
  printf '%s: ' '${NODE_UNSUPPORTED_MARKER}' >&2
  node --version >&2 || true
  exit ${NODE_UNSUPPORTED_EXIT_CODE}
fi

if [ -d "$install_dir" ] && [ ! -L "$install_dir" ] && [ -f "$receipt" ] &&
  node -e '${RECEIPT_MATCH_JS}' "$receipt" "$expected_receipt" &&
  node -e '${VERIFY_INSTALL_JS}' "$install_dir" "$hash" "$install"; then
  printf '%s\t%s\t' '${BOOTSTRAP_OUTPUT_TAG}' current
  cat "$receipt"
  printf '\n'
  exit 0
fi

incoming=$root/.incoming
ensure_private_directory "$incoming"
incoming=$(cd "$incoming" && pwd -P)
find "$incoming" -type f -name 'openclaw-upload-*.tgz.*' -mmin +60 -exec rm -f -- {} + 2>/dev/null || true
upload=$(mktemp "$incoming/openclaw-upload-$hash.tgz.XXXXXXXX")
printf '%s\t%s\t%s\n' '${BOOTSTRAP_OUTPUT_TAG}' install "$upload"
`;

const INSTALL_SCRIPT = String.raw`set -eu
umask 077
install=$1
hash=$2
package_spec=$3
package_integrity=$4
receipt_json=$5
upload=$6
archive_sha256=$7
root=$HOME/${BOOTSTRAP_ROOT}
install_dir=$root/$hash
receipt=$install_dir/${BOOTSTRAP_RECEIPT}
staging=$root/.staging-$hash-$$
lock_root=$root/.locks
lock=$lock_root/$hash
locked=0
lock_identity="$$:$(date +%s)"

ensure_private_directory() {
  directory=$1
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    if [ ! -d "$directory" ] || [ -L "$directory" ]; then
      printf '%s\n' 'unsafe worker bootstrap directory' >&2
      exit 2
    fi
  else
    mkdir "$directory"
  fi
  chmod 700 "$directory"
}

ensure_private_directory "$root"
ensure_private_directory "$lock_root"

cleanup() {
  rm -rf "$staging"
  if [ "$locked" -eq 1 ]; then
    owner=$(readlink "$lock" 2>/dev/null || true)
    if [ "$owner" = "$lock_identity" ]; then
      rm -f "$lock"
    fi
  fi
  if [ -n "$upload" ]; then
    rm -f "$upload"
  fi
}
trap cleanup 0
trap 'exit 1' 1 2 15

receipt_matches() {
  [ -d "$install_dir" ] && [ ! -L "$install_dir" ] && [ -f "$receipt" ] &&
    node -e '${RECEIPT_MATCH_JS}' "$receipt" "$receipt_json" &&
    node -e '${VERIFY_INSTALL_JS}' "$install_dir" "$hash" "$install"
}

read_lock_owner() {
  if [ -L "$lock" ]; then
    readlink "$lock" 2>/dev/null || true
  elif [ -r "$lock/pid" ]; then
    cat "$lock/pid" 2>/dev/null || true
  fi
}

attempt=0
while ! ln -s "$lock_identity" "$lock" 2>/dev/null; do
  if receipt_matches; then
    printf '%s\t%s\t' '${BOOTSTRAP_OUTPUT_TAG}' receipt
    cat "$receipt"
    printf '\n'
    exit 0
  fi
  owner=$(read_lock_owner)
  stale_owner=0
  case "$owner" in
    *:*:*) valid_owner=0 ;;
    *:*)
      owner_pid=${"${"}owner%%:*}
      owner_started=${"${"}owner#*:}
      case "$owner_pid" in
        *[!0-9]*|'') valid_owner=0 ;;
        *)
          case "$owner_started" in
            *[!0-9]*|'') valid_owner=0 ;;
            *)
              now=$(date +%s)
              if [ "$owner_started" -le "$now" ] && [ $((now - owner_started)) -le ${LOCK_MAX_AGE_SECONDS} ]; then
                valid_owner=1
              else
                valid_owner=0
                stale_owner=1
              fi
              ;;
          esac
          ;;
      esac
      ;;
    *) valid_owner=0 ;;
  esac
  if [ "$stale_owner" -eq 1 ]; then
    current_owner=$(read_lock_owner)
    if [ "$current_owner" = "$owner" ]; then
      if [ -L "$lock" ]; then rm -f "$lock"; else rm -rf "$lock"; fi
    fi
    continue
  fi
  if [ "$valid_owner" -eq 1 ] && kill -0 "$owner_pid" 2>/dev/null; then
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      printf '%s\n' 'worker bootstrap lock timed out' >&2
      exit ${LOCK_TIMEOUT_EXIT_CODE}
    fi
    sleep 1
    continue
  fi
  if [ "$valid_owner" -eq 1 ]; then
    current_owner=$(read_lock_owner)
    if [ "$current_owner" = "$owner" ]; then
      if [ -L "$lock" ]; then rm -f "$lock"; else rm -rf "$lock"; fi
    fi
    continue
  fi
  attempt=$((attempt + 1))
  if [ "$valid_owner" -eq 0 ] && [ "$attempt" -ge 5 ]; then
    current_owner=$(read_lock_owner)
    if [ "$current_owner" = "$owner" ]; then
      if [ -L "$lock" ]; then rm -f "$lock"; else rm -rf "$lock"; fi
    fi
    continue
  fi
  sleep 1
done
locked=1

# The per-hash lock makes cleanup safe: no live installer for this build can own an older staging dir.
for stale_staging in "$root"/.staging-"$hash"-*; do
  if [ -L "$stale_staging" ]; then
    rm -f "$stale_staging"
  elif [ -d "$stale_staging" ]; then
    rm -rf "$stale_staging"
  fi
done

if receipt_matches; then
  printf '%s\t%s\t' '${BOOTSTRAP_OUTPUT_TAG}' receipt
  cat "$receipt"
  printf '\n'
  exit 0
fi

rm -rf "$staging"
mkdir -p "$staging"
case "$install" in
  bundle)
    if ! node -e '${VERIFY_ARCHIVE_JS}' "$upload" "$archive_sha256"; then
      printf '%s\n' 'worker bundle archive digest mismatch' >&2
      exit 2
    fi
    tar -xzf "$upload" -C "$staging"
    ;;
  npm)
    if ! command -v npm >/dev/null 2>&1; then
      printf '%s\n' '${NPM_MISSING_MARKER}' >&2
      exit ${NPM_MISSING_EXIT_CODE}
    fi
    npm_prefix=$staging/.npm-prefix
    npm_pack_json=$staging/npm-pack.json
    OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION=1 npm pack "$package_spec" --pack-destination "$staging" --ignore-scripts --json --registry=https://registry.npmjs.org/ > "$npm_pack_json"
    package_archive=$(node -e '${READ_NPM_PACK_FILENAME_JS}' "$npm_pack_json")
    package_archive=$staging/$package_archive
    if ! node -e '${VERIFY_NPM_PACKAGE_JS}' "$package_archive" "$package_integrity"; then
      printf '%s\n' 'worker npm package integrity mismatch' >&2
      exit 2
    fi
    OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION=1 npm install --global --prefix "$npm_prefix" --ignore-scripts --omit=dev --no-audit --no-fund "$package_archive"
    package_dir=$npm_prefix/lib/node_modules/openclaw
    if [ ! -f "$package_dir/openclaw.mjs" ]; then
      printf '%s\n' 'npm did not install the OpenClaw package root' >&2
      exit 2
    fi
    # Match bundle layout so the worker entry always lives under the versioned root.
    cp -R "$package_dir/." "$staging/"
    rm -rf "$npm_prefix"
    rm -f "$npm_pack_json" "$package_archive"
    ;;
  *)
    printf '%s\n' 'invalid worker install channel' >&2
    exit 2
    ;;
esac

if ! node -e '${VERIFY_INSTALL_JS}' "$staging" "$hash" "$install"; then
  printf '%s\n' 'worker install content does not match the expected bundle hash' >&2
  exit 2
fi
# Materialize production dependencies only after the pristine bundle passed its
# integrity check; npm install writes node_modules the hash intentionally excludes.
if [ "$install" = bundle ]; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' '${NPM_MISSING_MARKER}' >&2
    exit ${NPM_MISSING_EXIT_CODE}
  fi
  OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION=1 npm install --prefix "$staging" --ignore-scripts --omit=dev --no-audit --no-fund >&2
fi
printf '%s\n' "$receipt_json" > "$staging/${BOOTSTRAP_RECEIPT}"
chmod 600 "$staging/${BOOTSTRAP_RECEIPT}"
rm -rf "$install_dir"
mv "$staging" "$install_dir"
printf '%s\t%s\t' '${BOOTSTRAP_OUTPUT_TAG}' receipt
cat "$receipt"
printf '\n'
`;

type ResolvedWorkerSshIdentity = WorkerSshIdentity;

type WorkerBootstrapCommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<SpawnResult>;

type WorkerBootstrapRequest = {
  ssh: WorkerSshEndpoint;
  artifact: WorkerInstallationArtifact;
  /** Provider endpoint host key copied by the gateway bootstrap adapter. */
  pinnedHostKey?: string;
};

type WorkerBootstrapDependencies = {
  resolveIdentity: (keyRef: WorkerSshEndpoint["keyRef"]) => Promise<ResolvedWorkerSshIdentity>;
  runCommand?: WorkerBootstrapCommandRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function normalizeHandshake(artifact: WorkerInstallationArtifact): WorkerAdmissionHandshake {
  const bundleHash = artifact.bundleHash.trim();
  const openclawVersion = artifact.openclawVersion.trim();
  const protocolFeatures = artifact.protocolFeatures.map((feature) => feature.trim());
  if (!BUNDLE_HASH_PATTERN.test(bundleHash)) {
    throw new Error("Worker bundle hash must be a lowercase SHA-256 digest");
  }
  if (!openclawVersion) {
    throw new Error("Worker OpenClaw version must be non-empty");
  }
  if (
    protocolFeatures.length > WORKER_PROTOCOL_MAX_FEATURES ||
    protocolFeatures.some((feature) => !feature) ||
    protocolFeatures.some((feature) => feature.length > WORKER_PROTOCOL_MAX_FEATURE_LENGTH) ||
    new Set(protocolFeatures).size !== protocolFeatures.length
  ) {
    throw new Error("Worker protocol features must be unique non-empty strings");
  }
  if (artifact.install === "npm") {
    if (
      !isExactSemverVersion(openclawVersion) ||
      artifact.packageSpec !== `openclaw@${openclawVersion}`
    ) {
      throw new Error(`Worker npm install must use exact package openclaw@${openclawVersion}`);
    }
    if (!NPM_INTEGRITY_PATTERN.test(artifact.packageIntegrity)) {
      throw new Error("Worker npm install requires a pinned SHA-512 package integrity");
    }
  } else if (!BUNDLE_HASH_PATTERN.test(artifact.tarballSha256)) {
    throw new Error("Worker bundle archive digest must be a lowercase SHA-256 digest");
  }
  return { bundleHash, openclawVersion, protocolFeatures };
}

function parseReceiptJson(
  value: string | undefined,
  expected: WorkerAdmissionHandshake,
): WorkerAdmissionHandshake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "");
  } catch {
    throw new Error("Worker bootstrap returned an invalid receipt");
  }
  if (!validateWorkerAdmissionHandshake(parsed)) {
    throw new Error("Worker bootstrap returned an invalid receipt");
  }
  if (
    parsed.bundleHash !== expected.bundleHash ||
    parsed.openclawVersion !== expected.openclawVersion ||
    parsed.protocolFeatures.length !== expected.protocolFeatures.length ||
    parsed.protocolFeatures.some((feature, index) => feature !== expected.protocolFeatures[index])
  ) {
    throw new Error("Worker bootstrap receipt does not match the requested artifact");
  }
  return parsed;
}

function commandFailure(phase: string, result: SpawnResult): Error {
  const output = truncateUtf16Safe(
    redactSensitiveText(result.stderr.trim() || result.stdout.trim(), {
      mode: "tools",
    }).replace(/\s+/gu, " "),
    512,
  );
  const status =
    result.termination === "exit" ? `exit ${result.code ?? "unknown"}` : result.termination;
  return new Error(`Worker bootstrap ${phase} failed (${status})${output ? `: ${output}` : ""}`);
}

function isSuccess(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

async function runSshScript(params: {
  prepared: PreparedWorkerSsh;
  runCommand: WorkerBootstrapCommandRunner;
  script: string;
  scriptArgs: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  return await params.runCommand(
    [
      "ssh",
      ...workerSshOptions(params.prepared, { forwarding: "disabled" }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(params.prepared.port),
      "--",
      params.prepared.sshTarget,
      workerSshRemoteCommand(["sh", "-s", "--", ...params.scriptArgs]),
    ],
    workerSshCommandOptions({
      input: params.script,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    }),
  );
}

const CLEANUP_UPLOAD_SCRIPT = String.raw`set -eu
rm -f -- "$1"
`;

async function cleanupRemoteUpload(params: {
  prepared: PreparedWorkerSsh;
  remotePath: string;
  runCommand: WorkerBootstrapCommandRunner;
  timeoutMs: number;
}): Promise<void> {
  await runSshScript({
    prepared: params.prepared,
    runCommand: params.runCommand,
    script: CLEANUP_UPLOAD_SCRIPT,
    scriptArgs: [params.remotePath],
    timeoutMs: Math.min(params.timeoutMs, 10_000),
  }).catch(() => undefined);
}

function parseTaggedOutput(stdout: string): { action: string; payload: string } | undefined {
  const prefix = `${BOOTSTRAP_OUTPUT_TAG}\t`;
  const record = stdout.split(/\r?\n/u).findLast((line) => line.startsWith(prefix));
  if (!record) {
    return undefined;
  }
  const actionEnd = record.indexOf("\t", prefix.length);
  if (actionEnd === -1) {
    return undefined;
  }
  const action = record.slice(prefix.length, actionEnd);
  const payload = record.slice(actionEnd + 1).trim();
  return action && payload ? { action, payload } : undefined;
}

function parsePreflight(
  result: SpawnResult,
  expected: WorkerAdmissionHandshake,
): { action: "current"; receipt: WorkerAdmissionHandshake } | { action: "install"; path: string } {
  if (
    result.code === NODE_MISSING_EXIT_CODE ||
    result.stderr.includes(NODE_MISSING_MARKER) ||
    result.stdout.includes(NODE_MISSING_MARKER)
  ) {
    throw new Error(
      "Worker bootstrap requires Node.js on the leased host; install Node in the provider setup phase and retry",
    );
  }
  if (
    result.code === NODE_UNSUPPORTED_EXIT_CODE ||
    result.stderr.includes(NODE_UNSUPPORTED_MARKER) ||
    result.stdout.includes(NODE_UNSUPPORTED_MARKER)
  ) {
    throw new Error(
      "Worker bootstrap requires Node 22.22.3+, 24.15.0+, or 25.9.0+ with WAL-reset-safe SQLite on the leased host; install a supported Node runtime in the provider setup phase and retry",
    );
  }
  if (!isSuccess(result)) {
    throw commandFailure("preflight", result);
  }
  const output = parseTaggedOutput(result.stdout);
  if (output?.action === "current") {
    return { action: "current", receipt: parseReceiptJson(output.payload, expected) };
  }
  const remotePath = output?.action === "install" ? output.payload : undefined;
  const normalizedPath = normalizeScpRemotePath(remotePath);
  if (!normalizedPath) {
    throw new Error("Worker bootstrap preflight returned an invalid upload path");
  }
  return { action: "install", path: normalizedPath };
}

/** Installs one exact worker artifact over SSH and returns its admission receipt. */
export async function bootstrapWorker(
  request: WorkerBootstrapRequest,
  dependencies: WorkerBootstrapDependencies,
): Promise<WorkerAdmissionHandshake> {
  const receipt = normalizeHandshake(request.artifact);
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const runCommand = dependencies.runCommand ?? runCommandWithTimeout;
  const prepared = await prepareWorkerSsh({
    ssh: request.ssh,
    pinnedHostKey: request.pinnedHostKey,
    resolveIdentity: dependencies.resolveIdentity,
    temporaryDirectoryPrefix: "openclaw-worker-bootstrap-",
  });
  try {
    const preflight = parsePreflight(
      await runSshScript({
        prepared,
        runCommand,
        script: PREFLIGHT_SCRIPT,
        scriptArgs: [receipt.bundleHash, JSON.stringify(receipt), request.artifact.install],
        timeoutMs,
        signal: dependencies.signal,
      }),
      receipt,
    );
    if (preflight.action === "current") {
      return preflight.receipt;
    }

    try {
      if (request.artifact.install === "bundle") {
        const transfer = await runCommand(
          [
            "scp",
            ...workerSshOptions(prepared, { forwarding: "disabled" }),
            "-P",
            String(prepared.port),
            "--",
            request.artifact.tarballPath,
            `${prepared.scpTarget}:${preflight.path}`,
          ],
          workerSshCommandOptions({ timeoutMs, signal: dependencies.signal }),
        );
        if (!isSuccess(transfer)) {
          throw commandFailure("bundle transfer", transfer);
        }
      }

      const install = await runSshScript({
        prepared,
        runCommand,
        script: INSTALL_SCRIPT,
        scriptArgs: [
          request.artifact.install,
          receipt.bundleHash,
          request.artifact.install === "npm" ? request.artifact.packageSpec : "",
          request.artifact.install === "npm" ? request.artifact.packageIntegrity : "",
          JSON.stringify(receipt),
          preflight.path,
          request.artifact.install === "bundle" ? request.artifact.tarballSha256 : "",
        ],
        timeoutMs,
        signal: dependencies.signal,
      });
      if (
        install.code === NPM_MISSING_EXIT_CODE ||
        install.stderr.includes(NPM_MISSING_MARKER) ||
        install.stdout.includes(NPM_MISSING_MARKER)
      ) {
        throw new Error(
          "Worker npm bootstrap requires npm on the leased host; use bundle install or provide npm in the provider setup phase",
        );
      }
      if (!isSuccess(install)) {
        throw commandFailure("install", install);
      }
      const output = parseTaggedOutput(install.stdout);
      if (output?.action !== "receipt") {
        throw new Error("Worker bootstrap install returned an invalid receipt");
      }
      return parseReceiptJson(output.payload, receipt);
    } catch (error) {
      await cleanupRemoteUpload({
        prepared,
        remotePath: preflight.path,
        runCommand,
        timeoutMs,
      });
      throw error;
    }
  } finally {
    await prepared.dispose();
  }
}
