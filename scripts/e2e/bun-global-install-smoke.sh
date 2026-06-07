#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
BUN_BIN="${BUN_BIN:-bun}"
HOST_BUILD="${OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD:-1}"
DIST_IMAGE="${OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE:-}"
PACKAGE_TGZ="${OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ:-}"
COMMAND_TIMEOUT_MS="${OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS:-180000}"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_BUN_GLOBAL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"
SMOKE_DIR=""
PACK_DIR=""

cleanup() {
  if [ -n "${SMOKE_DIR:-}" ]; then
    rm -rf "$SMOKE_DIR"
  fi
  if [ -n "${PACK_DIR:-}" ]; then
    rm -rf "$PACK_DIR"
  fi
}

trap cleanup EXIT

run_with_timeout() {
  local timeout_ms="$1"
  shift
  node scripts/e2e/lib/bun-global-install/assertions.mjs run-with-timeout "$timeout_ms" "$@"
}

restore_dist_from_image() {
  local image="$1"
  local backup_dir=""
  local container_id=""
  local swapped=0
  local temp_dir=""

  cleanup_restore_dist() {
    if [ -n "$container_id" ]; then
      docker_e2e_docker_cmd rm -f "$container_id" >/dev/null 2>&1 || true
    fi
    if [ "$swapped" != "1" ] && [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
      rm -rf "$ROOT_DIR/dist" >/dev/null 2>&1 || true
      if [ ! -e "$ROOT_DIR/dist" ] && mv "$backup_dir" "$ROOT_DIR/dist" >/dev/null 2>&1; then
        backup_dir=""
      fi
    fi
    if [ -n "$temp_dir" ]; then
      rm -rf "$temp_dir"
    fi
    if [ "$swapped" = "1" ] && [ -n "$backup_dir" ]; then
      rm -rf "$backup_dir"
    fi
  }

  echo "==> Reuse dist/ from Docker image: $image"
  if ! container_id="$(docker_e2e_docker_cmd create "$image")"; then
    cleanup_restore_dist
    return 1
  fi
  if ! temp_dir="$(mktemp -d "$ROOT_DIR/.bun-dist.XXXXXX")"; then
    cleanup_restore_dist
    return 1
  fi
  if ! docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$temp_dir/dist"; then
    cleanup_restore_dist
    return 1
  fi
  if [ -e "$ROOT_DIR/dist" ]; then
    if ! backup_dir="$(mktemp -d "$ROOT_DIR/.dist-backup.XXXXXX")"; then
      cleanup_restore_dist
      return 1
    fi
    if ! rmdir "$backup_dir"; then
      cleanup_restore_dist
      return 1
    fi
    if ! mv "$ROOT_DIR/dist" "$backup_dir"; then
      cleanup_restore_dist
      return 1
    fi
  fi
  if ! mv "$temp_dir/dist" "$ROOT_DIR/dist"; then
    cleanup_restore_dist
    return 1
  fi
  swapped=1
  cleanup_restore_dist
}

resolve_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    if [ ! -f "$PACKAGE_TGZ" ]; then
      echo "OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ does not exist: $PACKAGE_TGZ" >&2
      exit 1
    fi
    PACKAGE_TGZ="$(cd "$(dirname "$PACKAGE_TGZ")" && pwd)/$(basename "$PACKAGE_TGZ")"
    return 0
  fi

  if [ -n "$DIST_IMAGE" ]; then
    restore_dist_from_image "$DIST_IMAGE"
  elif [ "$HOST_BUILD" != "0" ]; then
    echo "==> Build host package artifacts"
    pnpm build
  else
    echo "==> Skipping host build (OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD=0)"
  fi

  if [ ! -d "$ROOT_DIR/dist" ]; then
    echo "dist/ is missing; run pnpm build or set OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE" >&2
    exit 1
  fi

  echo "==> Write package inventory"
  node --import tsx scripts/write-package-dist-inventory.ts

  local pack_json_file
  PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-pack.XXXXXX")"
  pack_json_file="$PACK_DIR/pack.json"

  echo "==> Pack OpenClaw tarball"
  npm pack --ignore-scripts --json --pack-destination "$PACK_DIR" >"$pack_json_file"
  PACKAGE_TGZ="$(
    node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8") || "[]";
const parsed = JSON.parse(raw);
const last = Array.isArray(parsed) ? parsed.at(-1) : null;
if (!last || typeof last.filename !== "string" || last.filename.length === 0) {
  process.exit(1);
}
process.stdout.write(require("node:path").resolve(process.argv[2], last.filename));
' "$pack_json_file" "$PACK_DIR"
  )"
  if [ -z "$PACKAGE_TGZ" ] || [ ! -f "$PACKAGE_TGZ" ]; then
    echo "missing packed OpenClaw tarball" >&2
    exit 1
  fi
}

main() {
  cd "$ROOT_DIR"

  if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
    echo "Bun is required for bun global install smoke; set BUN_BIN or install bun." >&2
    exit 1
  fi

  resolve_package_tgz

  local bun_path
  local openclaw_bin
  bun_path="$(command -v "$BUN_BIN")"
  SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-global.XXXXXX")"

  export HOME="$SMOKE_DIR/home"
  export BUN_INSTALL="$HOME/.bun"
  export XDG_CACHE_HOME="$SMOKE_DIR/cache"
  export OPENCLAW_NO_ONBOARD=1
  export OPENCLAW_DISABLE_UPDATE_CHECK=1
  export NO_COLOR=1
  mkdir -p "$HOME" "$BUN_INSTALL/bin" "$XDG_CACHE_HOME"
  export PATH="$BUN_INSTALL/bin:$(dirname "$(command -v node)"):$PATH"

  echo "==> Bun version"
  "$bun_path" --version

  echo "==> Bun global install packed OpenClaw"
  "$bun_path" install -g "$PACKAGE_TGZ" --no-progress

  openclaw_bin="$BUN_INSTALL/bin/openclaw"
  if [ ! -x "$openclaw_bin" ]; then
    openclaw_bin="$(command -v openclaw || true)"
  fi
  if [ -z "$openclaw_bin" ] || [ ! -x "$openclaw_bin" ]; then
    echo "Bun global install did not create an executable openclaw binary" >&2
    exit 1
  fi

  echo "==> OpenClaw version through Bun global install"
  run_with_timeout "$COMMAND_TIMEOUT_MS" "$openclaw_bin" --version

  echo "==> OpenClaw image providers through Bun global install"
  local providers_json
  providers_json="$(run_with_timeout "$COMMAND_TIMEOUT_MS" "$openclaw_bin" infer image providers --json)"
  OPENCLAW_IMAGE_PROVIDERS_JSON="$providers_json" node scripts/e2e/lib/bun-global-install/assertions.mjs assert-image-providers
}

main "$@"
