#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./docker/install-sh-common/version-parse.sh
source "$ROOT_DIR/scripts/docker/install-sh-common/version-parse.sh"

resolve_default_smoke_platform() {
  local host_os
  local host_arch
  if [[ -n "${OPENCLAW_INSTALL_SMOKE_PLATFORM:-}" ]]; then
    printf "%s" "$OPENCLAW_INSTALL_SMOKE_PLATFORM"
    return
  fi
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf "linux/amd64"
    return
  fi
  host_os="$(uname -s)"
  host_arch="$(uname -m)"
  if [[ "$host_os" == "Darwin" && "$host_arch" == "arm64" ]]; then
    printf "linux/arm64"
    return
  fi
  printf "linux/amd64"
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
import { collectPackUnpackedSizeErrors } from "./scripts/lib/npm-pack-budget.mjs";

const label = process.argv[2];
const packJsonFile = process.argv[3];
const raw = readFileSync(packJsonFile, "utf8") || "[]";
const parsed = JSON.parse(raw);
const budgetOverride = process.env.OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES;
const budgetBytes = budgetOverride ? Number(budgetOverride) : undefined;
if (budgetOverride && !Number.isFinite(budgetBytes)) {
  throw new Error(
    `OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES must be numeric, got ${JSON.stringify(
      budgetOverride,
    )}`,
  );
}
const errors = collectPackUnpackedSizeErrors(parsed, {
  budgetBytes,
  missingDataMessage: `${label} npm pack output did not include unpackedSize; install smoke cannot verify pack budget.`,
});
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

SMOKE_IMAGE="${OPENCLAW_INSTALL_SMOKE_IMAGE:-openclaw-install-smoke:local}"
NONROOT_IMAGE="${OPENCLAW_INSTALL_NONROOT_IMAGE:-openclaw-install-nonroot:local}"
SMOKE_PLATFORM="$(resolve_default_smoke_platform)"
NONROOT_PLATFORM="${OPENCLAW_INSTALL_NONROOT_PLATFORM:-$SMOKE_PLATFORM}"
INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
CLI_INSTALL_URL="${OPENCLAW_INSTALL_CLI_URL:-https://openclaw.bot/install-cli.sh}"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-openclaw}"
SKIP_NONROOT="${OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT:-0}"
SKIP_SMOKE_IMAGE_BUILD="${OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD:-0}"
SKIP_NONROOT_IMAGE_BUILD="${OPENCLAW_INSTALL_NONROOT_SKIP_IMAGE_BUILD:-0}"
SKIP_UPDATE="${OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE:-0}"
SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"
UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE:-2026.4.10}"
UPDATE_PACKAGE_SPEC="${OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC:-}"
UPDATE_DIST_IMAGE="${OPENCLAW_INSTALL_SMOKE_UPDATE_DIST_IMAGE:-}"
UPDATE_SKIP_LOCAL_BUILD="${OPENCLAW_INSTALL_SMOKE_UPDATE_SKIP_LOCAL_BUILD:-0}"
UPDATE_HOST_ALIAS="${OPENCLAW_INSTALL_SMOKE_UPDATE_HOST:-host.docker.internal}"
UPDATE_PORT="${OPENCLAW_INSTALL_SMOKE_UPDATE_PORT:-}"
UPDATE_EXPECT_VERSION="${OPENCLAW_INSTALL_SMOKE_UPDATE_EXPECT_VERSION:-}"
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
NPM_CACHE_DOCKER_ARGS=()

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

restore_local_dist_from_image() {
  local image="$1"
  local container_id=""

  echo "==> Reuse local dist/ from Docker image: $image"
  container_id="$(docker create "$image")"
  rm -rf "$ROOT_DIR/dist"
  if ! docker cp "${container_id}:/app/dist" "$ROOT_DIR/dist"; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
    return 1
  fi
  docker rm -f "$container_id" >/dev/null
}

prepare_update_tarball() {
  local pack_json
  local baseline_pack_json
  local pack_json_file
  local baseline_pack_json_file
  local packed_update_version
  pack_json_file="${UPDATE_DIR}/pack.json"
  baseline_pack_json_file="${UPDATE_DIR}/baseline-pack.json"
  if [[ -n "$UPDATE_PACKAGE_SPEC" ]]; then
    echo "==> Pack update tgz from spec: $UPDATE_PACKAGE_SPEC"
    quiet_npm pack "$UPDATE_PACKAGE_SPEC" --json --pack-destination "$UPDATE_DIR" >"$pack_json_file"
  else
    echo "==> Build local release artifacts for update smoke"
    if [[ -n "$UPDATE_DIST_IMAGE" ]]; then
      restore_local_dist_from_image "$UPDATE_DIST_IMAGE"
    elif [[ "$UPDATE_SKIP_LOCAL_BUILD" != "1" ]]; then
      pnpm build
      pnpm ui:build
    fi
    UPDATE_EXPECT_VERSION="$(
      node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version'
    )"
    node --import tsx scripts/write-package-dist-inventory.ts
    quiet_npm pack --ignore-scripts --json --pack-destination "$UPDATE_DIR" >"$pack_json_file"
  fi
  UPDATE_TGZ_FILE="$(
    node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.filename !== "string" || last.filename.length === 0) {
  process.exit(1);
}
process.stdout.write(last.filename);
' "$pack_json_file"
  )"
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
  BASELINE_TGZ_FILE="$(
    node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.filename !== "string" || last.filename.length === 0) {
  process.exit(1);
}
process.stdout.write(last.filename);
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

if [[ "$SKIP_SMOKE_IMAGE_BUILD" == "1" ]]; then
  echo "==> Reuse prebuilt smoke image: $SMOKE_IMAGE"
else
  echo "==> Build smoke image (upgrade, root, ${SMOKE_PLATFORM}): $SMOKE_IMAGE"
  docker build \
    --platform "$SMOKE_PLATFORM" \
    -t "$SMOKE_IMAGE" \
    -f "$ROOT_DIR/scripts/docker/install-sh-smoke/Dockerfile" \
    "$ROOT_DIR/scripts/docker"
fi

if [[ "$SKIP_UPDATE" == "1" ]]; then
  echo "==> Skip update smoke (OPENCLAW_INSTALL_SMOKE_SKIP_UPDATE=1)"
else
  prepare_update_tarball
  prepare_update_host_access
  prepare_npm_cache
  start_update_server

  echo "==> Run installer smoke test (root): $FRESH_TAG_URL"
  docker run --rm -t \
    --platform "$SMOKE_PLATFORM" \
    ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
    "${NPM_CACHE_DOCKER_ARGS[@]}" \
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

  echo "==> Run update smoke (${UPDATE_BASELINE_VERSION} -> ${UPDATE_EXPECT_VERSION})"
  docker run --rm -t \
    --platform "$SMOKE_PLATFORM" \
    ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
    "${NPM_CACHE_DOCKER_ARGS[@]}" \
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
    docker run --rm -t \
      --platform "$SMOKE_PLATFORM" \
      ${UPDATE_DOCKER_HOST_ARGS[@]+"${UPDATE_DOCKER_HOST_ARGS[@]}"} \
      "${NPM_CACHE_DOCKER_ARGS[@]}" \
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

LATEST_VERSION="${LATEST_VERSION:-}"

if [[ "$SKIP_NONROOT" == "1" ]]; then
  echo "==> Skip non-root installer smoke (OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1)"
else
  if [[ "$SKIP_NONROOT_IMAGE_BUILD" == "1" ]]; then
    echo "==> Reuse prebuilt non-root image: $NONROOT_IMAGE"
  else
    echo "==> Build non-root image (${NONROOT_PLATFORM}): $NONROOT_IMAGE"
    docker build \
      --platform "$NONROOT_PLATFORM" \
      -t "$NONROOT_IMAGE" \
      -f "$ROOT_DIR/scripts/docker/install-sh-nonroot/Dockerfile" \
      "$ROOT_DIR/scripts/docker"
  fi

  echo "==> Run installer non-root test: $INSTALL_URL"
  docker run --rm -t \
    --platform "$NONROOT_PLATFORM" \
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
docker run --rm -t \
  --platform "$NONROOT_PLATFORM" \
  --entrypoint /bin/bash \
  -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
  -e OPENCLAW_INSTALL_CLI_URL="$CLI_INSTALL_URL" \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e DEBIAN_FRONTEND=noninteractive \
  "$NONROOT_IMAGE" -lc "curl -fsSL \"$CLI_INSTALL_URL\" | bash -s -- --set-npm-prefix --no-onboard"
