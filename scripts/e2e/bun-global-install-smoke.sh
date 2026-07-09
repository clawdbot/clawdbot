#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

read_positive_int_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [ -z "${!name+x}" ]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 )); then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf "%s\n" "$((10#$value))"
}

BUN_BIN="${BUN_BIN:-bun}"
HOST_BUILD="${OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD:-1}"
DIST_IMAGE="${OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE:-}"
PACKAGE_TGZ="${OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ:-}"
COMMAND_TIMEOUT_MS="$(read_positive_int_env OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS 180000)"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_BUN_GLOBAL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"
AI_PACKAGE_TGZ=""
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

prepare_ai_candidate() {
  local ai_manifest
  local ai_package_dir
  local ai_tarballs
  local root_manifest

  if [ -z "$PACK_DIR" ]; then
    PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-pack.XXXXXX")"
  fi
  echo "==> Extract bundled candidate @openclaw/ai package"
  ai_package_dir="$PACK_DIR/ai-candidate"
  mkdir -p "$ai_package_dir"
  tar -xzf "$PACKAGE_TGZ" \
    -C "$ai_package_dir" \
    --strip-components=4 \
    package/node_modules/@openclaw/ai
  root_manifest="$PACK_DIR/openclaw-package.json"
  ai_manifest="$ai_package_dir/package.json"
  tar -xOf "$PACKAGE_TGZ" package/package.json >"$root_manifest"
  node scripts/e2e/lib/bun-global-install/assertions.mjs \
    assert-release-versions \
    "$root_manifest" \
    "$ai_manifest" \
    >/dev/null
  npm pack --ignore-scripts --silent --pack-destination "$PACK_DIR" "$ai_package_dir" >/dev/null
  ai_tarballs=("$PACK_DIR"/openclaw-ai-*.tgz)
  if [ "${#ai_tarballs[@]}" -ne 1 ] || [ ! -f "${ai_tarballs[0]}" ]; then
    echo "expected one packed @openclaw/ai candidate in $PACK_DIR" >&2
    exit 1
  fi
  AI_PACKAGE_TGZ="${ai_tarballs[0]}"
}

trap cleanup EXIT

run_with_timeout() {
  local timeout_ms="$1"
  shift
  node scripts/e2e/lib/bun-global-install/assertions.mjs run-with-timeout "$timeout_ms" "$@"
}

restore_dist_from_image() {
  local image="$1"
  local ai_backup_dir=""
  local ai_dist_installed=0
  local backup_dir=""
  local container_id=""
  local dist_installed=0
  local restore_complete=0
  local temp_dir=""

  cleanup_restore_dist() {
    if [ -n "$container_id" ]; then
      docker_e2e_docker_cmd rm -f "$container_id" >/dev/null 2>&1 || true
    fi
    # Both build trees come from one image. A partial swap must restore both or
    # the following package step could mix artifacts from different builds.
    if [ "$restore_complete" != "1" ]; then
      if [ "$dist_installed" = "1" ]; then
        rm -rf "$ROOT_DIR/dist" >/dev/null 2>&1 || true
      fi
      if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
        if [ ! -e "$ROOT_DIR/dist" ] && mv "$backup_dir" "$ROOT_DIR/dist" >/dev/null 2>&1; then
          backup_dir=""
        fi
      fi
      if [ "$ai_dist_installed" = "1" ]; then
        rm -rf "$ROOT_DIR/packages/ai/dist" >/dev/null 2>&1 || true
      fi
      if [ -n "$ai_backup_dir" ] && [ -d "$ai_backup_dir" ]; then
        if [ ! -e "$ROOT_DIR/packages/ai/dist" ] && \
          mv "$ai_backup_dir" "$ROOT_DIR/packages/ai/dist" >/dev/null 2>&1; then
          ai_backup_dir=""
        fi
      fi
    fi
    if [ -n "$temp_dir" ]; then
      rm -rf "$temp_dir"
    fi
    if [ "$restore_complete" = "1" ] && [ -n "$backup_dir" ]; then
      rm -rf "$backup_dir"
    fi
    if [ "$restore_complete" = "1" ] && [ -n "$ai_backup_dir" ]; then
      rm -rf "$ai_backup_dir"
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
  if ! docker_e2e_docker_cmd cp \
    "${container_id}:/app/node_modules/@openclaw/ai/dist" \
    "$temp_dir/ai-dist"; then
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
  dist_installed=1
  if [ -e "$ROOT_DIR/packages/ai/dist" ]; then
    if ! ai_backup_dir="$(mktemp -d "$ROOT_DIR/packages/ai/.dist-backup.XXXXXX")"; then
      cleanup_restore_dist
      return 1
    fi
    if ! rmdir "$ai_backup_dir"; then
      cleanup_restore_dist
      return 1
    fi
    if ! mv "$ROOT_DIR/packages/ai/dist" "$ai_backup_dir"; then
      cleanup_restore_dist
      return 1
    fi
  fi
  if ! mv "$temp_dir/ai-dist" "$ROOT_DIR/packages/ai/dist"; then
    cleanup_restore_dist
    return 1
  fi
  ai_dist_installed=1
  restore_complete=1
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

  PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-pack.XXXXXX")"

  echo "==> Pack OpenClaw tarball"
  PACKAGE_TGZ="$(
    node scripts/package-openclaw-for-docker.mjs \
      --skip-build \
      --output-dir "$PACK_DIR" \
      --output-name openclaw-current.tgz
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
  prepare_ai_candidate

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
  mkdir -p "$HOME" "$BUN_INSTALL/bin" "$BUN_INSTALL/install/global" "$XDG_CACHE_HOME"
  export PATH="$BUN_INSTALL/bin:$(dirname "$(command -v node)"):$PATH"
  # Release publishes @openclaw/ai first. Bun 1.3.14 ignores bundled deps in
  # local tarballs, so resolve that one package from the exact candidate bytes.
  node --input-type=module - \
    "$BUN_INSTALL/install/global/package.json" \
    "$AI_PACKAGE_TGZ" <<'NODE'
import fs from "node:fs";

const [, , packageJsonPath, aiPackageTarball] = process.argv;
fs.writeFileSync(
  packageJsonPath,
  `${JSON.stringify({ private: true, overrides: { "@openclaw/ai": `file:${aiPackageTarball}` } })}\n`,
);
NODE

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
