#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${OPENCLAW_INSTALL_SMOKE_SOURCE_DIR:-$HARNESS_ROOT}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
# shellcheck source=./docker/install-sh-common/version-parse.sh
source "$HARNESS_ROOT/scripts/docker/install-sh-common/version-parse.sh"
source "$HARNESS_ROOT/scripts/lib/docker-build.sh"
source "$HARNESS_ROOT/scripts/lib/docker-e2e-package.sh"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"
INSTALL_SMOKE_DOCKER_RUN_TIMEOUT="${OPENCLAW_INSTALL_SMOKE_DOCKER_RUN_TIMEOUT:-2700s}"

normalize_npm_pack_json_file() {
  local pack_json_file="$1"
  node --input-type=module - "$pack_json_file" <<'NODE'
import fs from "node:fs";

const packJsonFile = process.argv[2];
const parsed = JSON.parse(fs.readFileSync(packJsonFile, "utf8"));
let entries = [parsed];
if (Array.isArray(parsed)) {
  entries = parsed;
} else if (parsed && typeof parsed === "object") {
  const looksLikeEntry =
    (typeof parsed.id === "string") ||
    (typeof parsed.name === "string") ||
    (typeof parsed.version === "string") ||
    (typeof parsed.filename === "string");
  if (!looksLikeEntry) {
    const keyedEntries = Object.values(parsed).filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    );
    if (keyedEntries.length > 0) {
      entries = keyedEntries;
    }
  }
}
if (entries.length === 0) {
  throw new Error("npm pack output did not contain a package result");
}
fs.writeFileSync(packJsonFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
NODE
}

run_install_smoke_container() {
  DOCKER_COMMAND_TIMEOUT="$INSTALL_SMOKE_DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run "$@"
}

resolve_default_smoke_platform() {
  local host_arch
  if [[ -n "${OPENCLAW_INSTALL_SMOKE_PLATFORM:-}" ]]; then
    printf "%s" "$OPENCLAW_INSTALL_SMOKE_PLATFORM"
    return
  fi
  host_arch="$(uname -m)"
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    case "$host_arch" in
      arm64 | aarch64)
        printf "linux/arm64"
        return
        ;;
    esac
    printf "linux/amd64"
    return
  fi
  case "$host_arch" in
    arm64 | aarch64)
      printf "linux/arm64"
      ;;
    *)
      printf "linux/amd64"
      ;;
  esac
}

print_pack_audit() {
  local label="$1"
  local pack_json_file="$2"
  node -e '
const raw = require("node:fs").readFileSync(process.argv[2], "utf8") || "[]";
const label = process.argv[1];
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last) {
  process.exit(1);
}
const formatBytes = (value) => {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
const fileCount = Number.isFinite(last.entryCount)
  ? last.entryCount
  : Array.isArray(last.files)
    ? last.files.length
    : "unknown";
console.log(
  `==> Pack audit (${label}): version=${last.version ?? "unknown"} tgz=${formatBytes(last.size)} unpacked=${formatBytes(last.unpackedSize)} files=${fileCount}`,
);
' "$label" "$pack_json_file"
}

assert_pack_unpacked_size_budget() {
  local label="$1"
  local pack_json_file="$2"
  node --input-type=module - "$label" "$pack_json_file" <<'NODE'
import { readFileSync } from "node:fs";

const label = process.argv[2];
const packJsonFile = process.argv[3];
const raw = readFileSync(packJsonFile, "utf8") || "[]";
const parsed = JSON.parse(raw);
const budgetOverride = process.env.OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES;
// Both bundled fs-safe loader layouts need all native targets (~31 MiB).
// Include that payload while retaining the previous package-size headroom.
const budgetBytes = budgetOverride ? Number(budgetOverride) : 235 * 1024 * 1024;
if (!Number.isFinite(budgetBytes)) {
  throw new Error(
    `OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES must be numeric, got ${JSON.stringify(
      budgetOverride,
    )}`,
  );
}
const entries = Array.isArray(parsed) ? parsed : [parsed];
const errors = [];
let checkedCount = 0;
for (const [index, entry] of entries.entries()) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.unpackedSize !== "number" ||
    !Number.isFinite(entry.unpackedSize)
  ) {
    continue;
  }
  checkedCount += 1;
  if (entry.unpackedSize > budgetBytes) {
    const resultLabel =
      typeof entry.filename === "string" && entry.filename.trim()
        ? entry.filename.trim()
        : `pack result #${index + 1}`;
    errors.push(
      `${resultLabel} unpackedSize ${entry.unpackedSize} bytes exceeds budget ${budgetBytes} bytes. Investigate duplicate channel shims, copied extension trees, or other accidental pack bloat before release.`,
    );
  }
}
if (entries.length > 0 && checkedCount === 0) {
  errors.push(
    `${label} npm pack output did not include unpackedSize; install smoke cannot verify pack budget.`,
  );
}
for (const error of errors) {
  console.error(`ERROR: ${error}`);
}
if (errors.length > 0) {
  process.exit(1);
}
NODE
}

print_pack_delta_audit() {
  local baseline_pack_json_file="$1"
  local update_pack_json_file="$2"
  node -e '
const fs = require("node:fs");
const [baselinePath, updatePath] = process.argv.slice(1);
const readLast = (path) => {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8") || "[]");
  return Array.isArray(parsed) ? parsed.at(-1) : null;
};
const baseline = readLast(baselinePath);
const update = readLast(updatePath);
if (!baseline || !update) {
  process.exit(1);
}
const formatSignedBytes = (value) => {
  if (!Number.isFinite(value)) return "unknown";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  let current = Math.abs(value);
  const units = ["B", "KiB", "MiB", "GiB"];
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${sign}${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
const fileCount = (entry) =>
  Number.isFinite(entry.entryCount)
    ? entry.entryCount
    : Array.isArray(entry.files)
      ? entry.files.length
      : undefined;
const baselineFiles = fileCount(baseline);
const updateFiles = fileCount(update);
const fileDelta =
  Number.isFinite(baselineFiles) && Number.isFinite(updateFiles)
    ? `${updateFiles - baselineFiles >= 0 ? "+" : ""}${updateFiles - baselineFiles}`
    : "unknown";
console.log(
  `==> Pack audit delta (${baseline.version ?? "baseline"} -> ${update.version ?? "update"}): tgz=${formatSignedBytes((update.size ?? NaN) - (baseline.size ?? NaN))} unpacked=${formatSignedBytes((update.unpackedSize ?? NaN) - (baseline.unpackedSize ?? NaN))} files=${fileDelta}`,
);
' "$baseline_pack_json_file" "$update_pack_json_file"
}

read_pack_tarball_filename() {
  local pack_json_file="$1"
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const raw = fs.readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
const filename = typeof last?.filename === "string" ? last.filename.trim() : "";
if (
  !filename.endsWith(".tgz") ||
  filename.includes("\0") ||
  filename !== path.basename(filename) ||
  filename !== path.win32.basename(filename)
) {
  console.error(`ERROR: npm pack reported unsafe tarball filename ${JSON.stringify(filename)}`);
  process.exit(1);
}
process.stdout.write(filename);
' "$pack_json_file"
}

SMOKE_IMAGE="${OPENCLAW_INSTALL_SMOKE_IMAGE:-openclaw-install-smoke:local}"
NONROOT_IMAGE="${OPENCLAW_INSTALL_NONROOT_IMAGE:-openclaw-install-nonroot:local}"
SMOKE_PLATFORM="$(resolve_default_smoke_platform)"
NONROOT_PLATFORM="${OPENCLAW_INSTALL_NONROOT_PLATFORM:-$SMOKE_PLATFORM}"
INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
CLI_INSTALL_URL="${OPENCLAW_INSTALL_CLI_URL:-https://openclaw.bot/install-cli.sh}"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-openclaw}"
INSTALL_SMOKE_GROUP="${OPENCLAW_INSTALL_SMOKE_GROUP:-all}"
RUN_UPDATE_GROUP=0
RUN_NONROOT_GROUP=0

case "$INSTALL_SMOKE_GROUP" in
  all)
    RUN_UPDATE_GROUP=1
    RUN_NONROOT_GROUP=1
    ;;
  update)
    RUN_UPDATE_GROUP=1
    ;;
  nonroot)
    RUN_NONROOT_GROUP=1
    ;;
  *)
    echo "ERROR: OPENCLAW_INSTALL_SMOKE_GROUP must be all, update, or nonroot; got ${INSTALL_SMOKE_GROUP}" >&2
    exit 2
    ;;
esac

SKIP_NONROOT="${OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT:-0}"
SKIP_SMOKE_IMAGE_BUILD="${OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD:-0}"
SKIP_NONROOT_IMAGE_BUILD="${OPENCLAW_INSTALL_NONROOT_SKIP_IMAGE_BUILD:-0}"
SKIP_UPDATE="${OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE:-0}"
SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"
SKIP_FRESHNESS="${OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS:-0}"
FRESHNESS_INSTALL_URL="${OPENCLAW_INSTALL_SMOKE_FRESHNESS_INSTALL_URL:-file:///tmp/openclaw-install.sh}"
# npm min-release-age is days; 10000 keeps the control failure independent of normal release cadence.
FRESHNESS_MIN_RELEASE_AGE="${OPENCLAW_INSTALL_FRESHNESS_MIN_RELEASE_AGE:-10000}"
FRESHNESS_NPM_VERSION="${OPENCLAW_INSTALL_FRESHNESS_NPM_VERSION:-11.19.0}"
UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE:-latest}"
UPDATE_PACKAGE_SPEC="${OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC:-}"
UPDATE_DIST_IMAGE="${OPENCLAW_INSTALL_SMOKE_UPDATE_DIST_IMAGE:-}"
UPDATE_SKIP_LOCAL_BUILD="${OPENCLAW_INSTALL_SMOKE_UPDATE_SKIP_LOCAL_BUILD:-0}"
UPDATE_HOST_ALIAS="${OPENCLAW_INSTALL_SMOKE_UPDATE_HOST:-host.docker.internal}"
UPDATE_PORT="${OPENCLAW_INSTALL_SMOKE_UPDATE_PORT:-}"
UPDATE_EXPECT_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_EXPECT_VERSION:-}"
FROZEN_PAYLOAD_DIR="${OPENCLAW_INSTALL_SMOKE_FROZEN_PAYLOAD_DIR:-}"
LATEST_DIR="$(mktemp -d)"
LATEST_FILE="${LATEST_DIR}/latest"
UPDATE_DIR="$(mktemp -d)"
UPDATE_SERVER_PID=""
UPDATE_SERVER_LOG="${UPDATE_DIR}/http.log"
UPDATE_TGZ_FILE=""
BASELINE_TGZ_FILE=""
BASELINE_TAG_URL=""
FRESH_TAG_URL=""
UPDATE_TAG_URL=""
UPDATE_DOCKER_HOST_ARGS=()
NPM_CACHE_DIR="${OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR:-}"
NPM_CACHE_OWNED=0
NPM_CACHE_PREPARED=0
NPM_CACHE_DOCKER_ARGS=()
INSTALL_SCRIPT_PATH="$ROOT_DIR/scripts/install.sh"
CLI_INSTALL_SCRIPT_PATH="$ROOT_DIR/scripts/install-cli.sh"
SMOKE_RUNNER_ENV_ARGS=()

require_regular_payload_file() {
  local file_path="$1"
  local label="$2"
  if [[ ! -f "$file_path" || -L "$file_path" ]]; then
    echo "ERROR: frozen install-smoke ${label} must be a regular file: ${file_path}" >&2
    exit 1
  fi
}

if [[ -n "$FROZEN_PAYLOAD_DIR" ]]; then
  FROZEN_PAYLOAD_DIR="$(cd "$FROZEN_PAYLOAD_DIR" && pwd)"
  if [[ -n "$UPDATE_PACKAGE_SPEC" ]]; then
    echo "ERROR: frozen install-smoke payload cannot be combined with OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC" >&2
    exit 1
  fi
  require_regular_payload_file "$FROZEN_PAYLOAD_DIR/candidate.tgz" "package"
  require_regular_payload_file "$FROZEN_PAYLOAD_DIR/candidate-pack.json" "package metadata"
  require_regular_payload_file "$FROZEN_PAYLOAD_DIR/install.sh" "installer"
  require_regular_payload_file "$FROZEN_PAYLOAD_DIR/install-cli.sh" "CLI installer"
  if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then
    echo "ERROR: frozen install-smoke payload requires OPENCLAW_INSTALL_SMOKE_UPDATE_EXPECT_VERSION" >&2
    exit 1
  fi
  INSTALL_SCRIPT_PATH="$FROZEN_PAYLOAD_DIR/install.sh"
  CLI_INSTALL_SCRIPT_PATH="$FROZEN_PAYLOAD_DIR/install-cli.sh"
fi

INSTALL_SCRIPT_DOCKER_ARGS=(
  -v "$INSTALL_SCRIPT_PATH:/tmp/openclaw-install.sh:ro"
  -v "$CLI_INSTALL_SCRIPT_PATH:/tmp/openclaw-install-cli.sh:ro"
)

for env_name in \
  OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY \
  OPENCLAW_INSTALL_ALLOW_LEGACY_UPDATE_WARNING \
  OPENCLAW_INSTALL_SELF_UPDATE_WARNING_FIXED_VERSION \
  OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT \
  OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL \
  OPENCLAW_INSTALL_SMOKE_PREVIOUS \
  OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS; do
  env_value="${!env_name:-}"
  if [[ -n "$env_value" && "$env_value" != "undefined" && "$env_value" != "null" ]]; then
    SMOKE_RUNNER_ENV_ARGS+=(-e "$env_name")
  fi
done

remove_owned_npm_cache() {
  if [[ "$NPM_CACHE_OWNED" != "1" || -z "$NPM_CACHE_DIR" || ! -d "$NPM_CACHE_DIR" ]]; then
    return
  fi

  if rm -rf "$NPM_CACHE_DIR" 2>/dev/null; then
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n rm -rf "$NPM_CACHE_DIR" 2>/dev/null; then
    return
  fi

  echo "WARN: failed to remove temporary npm cache: $NPM_CACHE_DIR" >&2
}

cleanup() {
  if [[ -n "$UPDATE_SERVER_PID" ]]; then
    kill "$UPDATE_SERVER_PID" >/dev/null 2>&1 || true
    wait "$UPDATE_SERVER_PID" >/dev/null 2>&1 || true
  fi
  remove_owned_npm_cache || true
  rm -rf "$LATEST_DIR" "$UPDATE_DIR" || true
}

trap cleanup EXIT

allocate_host_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        process.exit(1);
      }
      process.stdout.write(String(address.port));
      server.close();
    });
  '
}

ensure_local_update_dist_import_closure() {
  if node "$HARNESS_ROOT/scripts/check-package-dist-imports.mjs" "$ROOT_DIR"; then
    return 0
  fi
  if [[ "$UPDATE_SKIP_LOCAL_BUILD" == "1" ]]; then
    echo "ERROR: reused Docker image package dist failed import-closure check; exact-image mode forbids a local rebuild" >&2
    return 1
  fi
  echo "WARN: reused Docker image dist failed import-closure check; rebuilding local release artifacts" >&2
  (
    cd "$ROOT_DIR"
    pnpm build
  )
}

read_candidate_version() {
  node -e '
const fs = require("node:fs");
const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(packageJson.version);
' "$ROOT_DIR/package.json"
}

prepare_update_tarball() {
  local pack_json_file
  local baseline_pack_json_file
  local -a package_args
  local package_tgz
  local packed_update_version
  pack_json_file="${UPDATE_DIR}/pack.json"
  baseline_pack_json_file="${UPDATE_DIR}/baseline-pack.json"
  if [[ -n "$FROZEN_PAYLOAD_DIR" ]]; then
    # The producer already built and normalized candidate bytes inside an isolated pinned image.
    # Privileged consumers only copy the verified artifact; they never build or import candidate code.
    echo "==> Reuse frozen candidate payload for update smoke"
    cp "$FROZEN_PAYLOAD_DIR/candidate.tgz" "${UPDATE_DIR}/candidate.tgz"
    cp "$FROZEN_PAYLOAD_DIR/candidate-pack.json" "$pack_json_file"
    UPDATE_TGZ_FILE="candidate.tgz"
  elif [[ -n "$UPDATE_PACKAGE_SPEC" ]]; then
    echo "==> Pack update tgz from spec: $UPDATE_PACKAGE_SPEC"
    quiet_npm pack "$UPDATE_PACKAGE_SPEC" --json --pack-destination "$UPDATE_DIR" >"$pack_json_file"
    normalize_npm_pack_json_file "$pack_json_file"
  else
    echo "==> Build local release artifacts for update smoke"
    if [[ -n "$UPDATE_DIST_IMAGE" ]]; then
      docker_e2e_restore_package_dist_from_image "$UPDATE_DIST_IMAGE"
      ensure_local_update_dist_import_closure
    elif [[ "$UPDATE_SKIP_LOCAL_BUILD" != "1" ]]; then
      (
        cd "$ROOT_DIR"
        pnpm build
      )
    fi
    UPDATE_EXPECT_VERSION="$(read_candidate_version)"
    package_args=(
      --source-dir "$ROOT_DIR"
      --output-dir "$UPDATE_DIR"
      --pack-json "$pack_json_file"
      --skip-build
    )
    if [[ "${OPENCLAW_INSTALL_SMOKE_ALLOW_UNRELEASED_CHANGELOG:-true}" == "true" ]]; then
      package_args+=(--allow-unreleased-changelog)
    fi
    package_tgz="$(
      node "$HARNESS_ROOT/scripts/package-openclaw-for-docker.mjs" "${package_args[@]}"
    )"
    UPDATE_TGZ_FILE="$(basename "$package_tgz")"
  fi
  if [[ -z "$FROZEN_PAYLOAD_DIR" ]]; then
    if [[ -z "$UPDATE_PACKAGE_SPEC" ]]; then
      node "$HARNESS_ROOT/scripts/check-openclaw-package-tarball.mjs" \
        --require-bundled-workspace-deps \
        "${UPDATE_DIR}/${UPDATE_TGZ_FILE}"
    else
      UPDATE_TGZ_FILE="$(read_pack_tarball_filename "$pack_json_file")"
    fi
  fi
  print_pack_audit "update" "$pack_json_file"
  assert_pack_unpacked_size_budget "update" "$pack_json_file"
  packed_update_version="$(
    node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.version !== "string" || last.version.length === 0) {
  process.exit(1);
}
process.stdout.write(last.version);
' "$pack_json_file"
  )"
  if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then
    UPDATE_EXPECT_VERSION="$packed_update_version"
  elif [[ "$UPDATE_EXPECT_VERSION" != "$packed_update_version" ]]; then
    echo "ERROR: packed update version ${packed_update_version} does not match expected ${UPDATE_EXPECT_VERSION}" >&2
    exit 1
  fi

  echo "==> Pack baseline tgz: ${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}"
  quiet_npm pack "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}" --json --pack-destination "$UPDATE_DIR" >"$baseline_pack_json_file"
  normalize_npm_pack_json_file "$baseline_pack_json_file"
  BASELINE_TGZ_FILE="$(read_pack_tarball_filename "$baseline_pack_json_file")"
  UPDATE_BASELINE_VERSION="$(
    node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.version !== "string" || last.version.length === 0) {
  process.exit(1);
}
process.stdout.write(last.version);
' "$baseline_pack_json_file"
  )"
  print_pack_audit "baseline" "$baseline_pack_json_file"
  print_pack_delta_audit "$baseline_pack_json_file" "$pack_json_file"
}

prepare_update_host_access() {
  local host_os
  host_os="$(uname -s)"
  UPDATE_DOCKER_HOST_ARGS=()
  if [[ "$host_os" == "Linux" ]]; then
    UPDATE_DOCKER_HOST_ARGS=(--add-host "${UPDATE_HOST_ALIAS}:host-gateway")
  fi
}

prepare_npm_cache() {
  if [[ "$NPM_CACHE_PREPARED" == "1" ]]; then
    return
  fi
  if [[ -z "$NPM_CACHE_DIR" ]]; then
    NPM_CACHE_DIR="$(mktemp -d)"
    NPM_CACHE_OWNED=1
  fi
  mkdir -p "$NPM_CACHE_DIR"
  chmod 0777 "$NPM_CACHE_DIR"
  NPM_CACHE_DOCKER_ARGS=(
    -v "${NPM_CACHE_DIR}:/npm-cache"
    -e npm_config_cache=/npm-cache
    -e NPM_CONFIG_CACHE=/npm-cache
  )
  NPM_CACHE_PREPARED=1
}

start_update_server() {
  if [[ -z "$UPDATE_PORT" ]]; then
    UPDATE_PORT="$(allocate_host_port)"
  fi
  BASELINE_TAG_URL="http://${UPDATE_HOST_ALIAS}:${UPDATE_PORT}/${BASELINE_TGZ_FILE}"
  FRESH_TAG_URL="http://${UPDATE_HOST_ALIAS}:${UPDATE_PORT}/${UPDATE_TGZ_FILE}"
  UPDATE_TAG_URL="http://${UPDATE_HOST_ALIAS}:${UPDATE_PORT}/${UPDATE_TGZ_FILE}"
  echo "==> Serve baseline tgz: $BASELINE_TAG_URL"
  echo "==> Serve latest tgz: $FRESH_TAG_URL"
  (
    cd "$UPDATE_DIR"
    exec python3 -m http.server "$UPDATE_PORT" --bind 0.0.0.0
  ) >"$UPDATE_SERVER_LOG" 2>&1 &
  UPDATE_SERVER_PID=$!
  sleep 1
  if ! kill -0 "$UPDATE_SERVER_PID" >/dev/null 2>&1; then
    echo "ERROR: failed to start update tgz server" >&2
    tail -n 50 "$UPDATE_SERVER_LOG" >&2 || true
    exit 1
  fi
}

if [[ "$RUN_UPDATE_GROUP" == "1" ]]; then
  if [[ "$SKIP_SMOKE_IMAGE_BUILD" == "1" ]]; then
    echo "==> Reuse prebuilt smoke image: $SMOKE_IMAGE"
  else
    echo "==> Build smoke image (upgrade, root, ${SMOKE_PLATFORM}): $SMOKE_IMAGE"
    docker_build_run install-smoke-build \
      --platform "$SMOKE_PLATFORM" \
      -t "$SMOKE_IMAGE" \
      -f "$HARNESS_ROOT/scripts/docker/install-sh-smoke/Dockerfile" \
      "$HARNESS_ROOT/scripts/docker"
  fi

  if [[ "$SKIP_UPDATE" == "1" ]]; then
    echo "==> Skip update smoke (OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE=1)"
  else
    prepare_update_tarball
    prepare_update_host_access
    prepare_npm_cache
    start_update_server

    echo "==> Run installer smoke test (root): $FRESH_TAG_URL"
    run_install_smoke_container --rm -t \
      --platform "$SMOKE_PLATFORM" \
      ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
      ${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"} \
      "${INSTALL_SCRIPT_DOCKER_ARGS[@]}" \
      ${SMOKE_RUNNER_ENV_ARGS[@]+"${SMOKE_RUNNER_ENV_ARGS[@]}"} \
      -v "${LATEST_DIR}:/out" \
      -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
      -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
      -e OPENCLAW_INSTALL_METHOD=npm \
      -e OPENCLAW_INSTALL_FRESH_VERSION="$UPDATE_EXPECT_VERSION" \
      -e OPENCLAW_INSTALL_FRESH_TAG_URL="$FRESH_TAG_URL" \
      -e OPENCLAW_INSTALL_LATEST_OUT="/out/latest" \
      -e OPENCLAW_NO_ONBOARD=1 \
      -e OPENCLAW_NO_PROMPT=1 \
      -e DEBIAN_FRONTEND=noninteractive \
      "$SMOKE_IMAGE"

    LATEST_VERSION=""
    if [[ -f "$LATEST_FILE" ]]; then
      LATEST_VERSION="$(cat "$LATEST_FILE")"
    fi
    public_latest_version="$(quiet_npm view "$PACKAGE_NAME" version 2>/dev/null || true)"
    if [[ -n "$public_latest_version" ]]; then
      LATEST_VERSION="$public_latest_version"
    fi

    echo "==> Run update smoke (${UPDATE_BASELINE_VERSION} -> ${UPDATE_EXPECT_VERSION})"
    run_install_smoke_container --rm -t \
      --platform "$SMOKE_PLATFORM" \
      ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
      ${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"} \
      ${SMOKE_RUNNER_ENV_ARGS[@]+"${SMOKE_RUNNER_ENV_ARGS[@]}"} \
      -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
      -e OPENCLAW_INSTALL_SMOKE_MODE=update \
      -e OPENCLAW_INSTALL_UPDATE_BASELINE="$UPDATE_BASELINE_VERSION" \
      -e OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL="$BASELINE_TAG_URL" \
      -e OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION="$UPDATE_EXPECT_VERSION" \
      -e OPENCLAW_INSTALL_UPDATE_TAG_URL="$UPDATE_TAG_URL" \
      -e OPENCLAW_NO_ONBOARD=1 \
      -e OPENCLAW_NO_PROMPT=1 \
      -e DEBIAN_FRONTEND=noninteractive \
      "$SMOKE_IMAGE"

    if [[ "$SKIP_NPM_GLOBAL" == "1" ]]; then
      echo "==> Skip direct npm global smoke (OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL=1)"
    else
      echo "==> Run direct npm global smoke (${UPDATE_BASELINE_VERSION} -> ${UPDATE_EXPECT_VERSION})"
      run_install_smoke_container --rm -t \
        --platform "$SMOKE_PLATFORM" \
        ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
        ${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"} \
        ${SMOKE_RUNNER_ENV_ARGS[@]+"${SMOKE_RUNNER_ENV_ARGS[@]}"} \
        -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
        -e OPENCLAW_INSTALL_SMOKE_MODE=npm-global \
        -e OPENCLAW_INSTALL_UPDATE_BASELINE="$UPDATE_BASELINE_VERSION" \
        -e OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL="$BASELINE_TAG_URL" \
        -e OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION="$UPDATE_EXPECT_VERSION" \
        -e OPENCLAW_INSTALL_UPDATE_TAG_URL="$UPDATE_TAG_URL" \
        -e OPENCLAW_NO_ONBOARD=1 \
        -e OPENCLAW_NO_PROMPT=1 \
        -e DEBIAN_FRONTEND=noninteractive \
        "$SMOKE_IMAGE"
    fi
  fi

  if [[ "$SKIP_FRESHNESS" == "1" ]]; then
    echo "==> Skip installer npm freshness smoke (OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS=1)"
  else
    prepare_npm_cache
    echo "==> Run installer npm freshness smoke"
    run_install_smoke_container --rm -t \
      --platform "$SMOKE_PLATFORM" \
      ${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"} \
      "${INSTALL_SCRIPT_DOCKER_ARGS[@]}" \
      ${SMOKE_RUNNER_ENV_ARGS[@]+"${SMOKE_RUNNER_ENV_ARGS[@]}"} \
      -e OPENCLAW_INSTALL_URL="$FRESHNESS_INSTALL_URL" \
      -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
      -e OPENCLAW_INSTALL_SMOKE_MODE=freshness \
      -e OPENCLAW_INSTALL_FRESHNESS_VERSION="${OPENCLAW_INSTALL_FRESHNESS_VERSION:-latest}" \
      -e OPENCLAW_INSTALL_FRESHNESS_MIN_RELEASE_AGE="$FRESHNESS_MIN_RELEASE_AGE" \
      -e OPENCLAW_INSTALL_FRESHNESS_NPM_VERSION="$FRESHNESS_NPM_VERSION" \
      -e OPENCLAW_NO_ONBOARD=1 \
      -e OPENCLAW_NO_PROMPT=1 \
      -e DEBIAN_FRONTEND=noninteractive \
      "$SMOKE_IMAGE"
  fi
else
  echo "==> Skip update installer smoke group"
fi

LATEST_VERSION="${LATEST_VERSION:-}"

if [[ "$RUN_NONROOT_GROUP" != "1" ]]; then
  echo "==> Skip non-root installer smoke group"
  exit 0
fi

if [[ -z "$LATEST_VERSION" ]]; then
  echo "==> Resolve public npm version for non-root installer assertion"
  LATEST_VERSION="$(quiet_npm view "$PACKAGE_NAME" version)"
fi

if [[ "$SKIP_NONROOT" == "1" ]]; then
  echo "==> Skip non-root installer smoke (OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1)"
else
  if [[ "$SKIP_NONROOT_IMAGE_BUILD" == "1" ]]; then
    echo "==> Reuse prebuilt non-root image: $NONROOT_IMAGE"
  else
    echo "==> Build non-root image (${NONROOT_PLATFORM}): $NONROOT_IMAGE"
    docker_build_run install-nonroot-build \
      --platform "$NONROOT_PLATFORM" \
      -t "$NONROOT_IMAGE" \
      -f "$HARNESS_ROOT/scripts/docker/install-sh-nonroot/Dockerfile" \
      "$HARNESS_ROOT/scripts/docker"
  fi

  echo "==> Run installer non-root test: $INSTALL_URL"
  run_install_smoke_container --rm -t \
    --platform "$NONROOT_PLATFORM" \
    "${INSTALL_SCRIPT_DOCKER_ARGS[@]}" \
    -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
    -e OPENCLAW_INSTALL_PACKAGE="$PACKAGE_NAME" \
    -e OPENCLAW_INSTALL_METHOD=npm \
    -e OPENCLAW_INSTALL_EXPECT_VERSION="$LATEST_VERSION" \
    -e OPENCLAW_NO_ONBOARD=1 \
    -e OPENCLAW_NO_PROMPT=1 \
    -e DEBIAN_FRONTEND=noninteractive \
    "$NONROOT_IMAGE"
fi

if [[ "${OPENCLAW_INSTALL_SMOKE_SKIP_CLI:-0}" == "1" ]]; then
  echo "==> Skip CLI installer smoke (OPENCLAW_INSTALL_SMOKE_SKIP_CLI=1)"
  exit 0
fi

if [[ "$SKIP_NONROOT" == "1" ]]; then
  echo "==> Skip CLI installer smoke (non-root image skipped)"
  exit 0
fi

echo "==> Run CLI installer non-root test (same image)"
run_install_smoke_container --rm -t \
  --platform "$NONROOT_PLATFORM" \
  --entrypoint /bin/bash \
  "${INSTALL_SCRIPT_DOCKER_ARGS[@]}" \
  -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
  -e OPENCLAW_INSTALL_CLI_URL="$CLI_INSTALL_URL" \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e DEBIAN_FRONTEND=noninteractive \
  "$NONROOT_IMAGE" -lc 'set -o pipefail; curl -fsSL --connect-timeout 30 --max-time 300 -- "$OPENCLAW_INSTALL_CLI_URL" | bash -s -- --set-npm-prefix --no-onboard'
