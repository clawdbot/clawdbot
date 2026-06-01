#!/usr/bin/env bash
#
# Shared package helpers for Docker E2E scripts.
# Builds or resolves one OpenClaw npm tarball and exposes mount/build-context
# helpers so Docker lanes test the package artifact instead of repo sources.

DOCKER_E2E_PACKAGE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "$DOCKER_E2E_PACKAGE_LIB_DIR/../.." && pwd)}"

if ! declare -F run_logged >/dev/null 2>&1; then
  source "$DOCKER_E2E_PACKAGE_LIB_DIR/docker-e2e-logs.sh"
fi
if ! declare -F docker_e2e_docker_cmd >/dev/null 2>&1; then
  source "$DOCKER_E2E_PACKAGE_LIB_DIR/docker-e2e-container.sh"
fi
if ! declare -F docker_e2e_docker_run_cmd >/dev/null 2>&1; then
  docker_e2e_docker_run_cmd() {
    if declare -F docker_e2e_timeout_cmd >/dev/null 2>&1; then
      docker_e2e_timeout_cmd "${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_DOCKER_E2E_RUN_TIMEOUT:-3600s}}" docker "$@"
      return
    fi
    local timeout_value="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_DOCKER_E2E_RUN_TIMEOUT:-3600s}}"
    local timeout_bin=""
    if command -v timeout >/dev/null 2>&1; then
      timeout_bin="timeout"
    elif command -v gtimeout >/dev/null 2>&1; then
      timeout_bin="gtimeout"
    fi
    if [ -n "$timeout_bin" ]; then
      if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
        "$timeout_bin" --kill-after=30s "$timeout_value" docker "$@"
      else
        "$timeout_bin" "$timeout_value" docker "$@"
      fi
      return
    fi
    echo "timeout command not found; cannot bound Docker run after ${timeout_value}" >&2
    return 127
  }
fi

docker_e2e_abs_path() {
  local file="$1"
  (cd "$(dirname "$file")" && printf '%s/%s\n' "$(pwd)" "$(basename "$file")")
}

docker_e2e_prepare_package_tgz() {
  local label="$1"
  local package_tgz="${2:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}"

  if [ -n "$package_tgz" ]; then
    if [ ! -f "$package_tgz" ]; then
      echo "OpenClaw package tarball does not exist: $package_tgz" >&2
      return 1
    fi
    docker_e2e_abs_path "$package_tgz"
    return 0
  fi

  local pack_dir
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-docker-e2e-pack.XXXXXX")"
  local pack_status=0
  package_tgz="$(
    node "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" \
      --output-dir "$pack_dir" \
      --output-name openclaw-current.tgz
  )" || pack_status="$?"
  if [ "$pack_status" -ne 0 ]; then
    rm -rf "$pack_dir"
    return "$pack_status"
  fi
  if [ -z "$package_tgz" ]; then
    echo "missing packed OpenClaw tarball" >&2
    rm -rf "$pack_dir"
    return 1
  fi
  touch "$pack_dir/.openclaw-docker-e2e-generated-package"
  docker_e2e_abs_path "$package_tgz"
}

docker_e2e_prepare_package_context() {
  local package_tgz="$1"
  local context_dir
  context_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-docker-e2e-package-context.XXXXXX")"
  # BuildKit named contexts must be directories, so expose the tarball as a
  # stable filename inside a tiny temporary context.
  local copy_status=0
  cp "$package_tgz" "$context_dir/openclaw-current.tgz" || copy_status="$?"
  if [ "$copy_status" -ne 0 ]; then
    rm -rf "$context_dir"
    return "$copy_status"
  fi
  printf '%s\n' "$context_dir"
}

docker_e2e_package_mount_args() {
  local package_tgz="$1"
  local target="${2:-/tmp/openclaw-current.tgz}"
  DOCKER_E2E_PACKAGE_ARGS=(-v "$package_tgz:$target:ro" -e "OPENCLAW_CURRENT_PACKAGE_TGZ=$target")
  if [ -n "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-}" ]; then
    DOCKER_E2E_PACKAGE_ARGS+=(-e "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$OPENCLAW_E2E_NPM_INSTALL_TIMEOUT")
  fi
  if [ -n "${OPENCLAW_E2E_COMMAND_TIMEOUT:-}" ]; then
    DOCKER_E2E_PACKAGE_ARGS+=(-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$OPENCLAW_E2E_COMMAND_TIMEOUT")
  fi
}

docker_e2e_cleanup_package_tgz() {
  local package_tgz="${1:-}"
  [ -n "$package_tgz" ] || return 0
  [ "$(basename "$package_tgz")" = "openclaw-current.tgz" ] || return 0

  local pack_dir
  pack_dir="$(dirname "$package_tgz")"
  if [ -f "$pack_dir/.openclaw-docker-e2e-generated-package" ]; then
    rm -rf "$pack_dir"
  fi
}

docker_e2e_cleanup_package_mount_args() {
  local expect_volume_path=0
  local arg
  for arg in "${DOCKER_E2E_PACKAGE_ARGS[@]:-}"; do
    if [ "$expect_volume_path" = "1" ]; then
      docker_e2e_cleanup_package_tgz "${arg%%:*}"
      expect_volume_path=0
      continue
    fi
    if [ "$arg" = "-v" ]; then
      expect_volume_path=1
    fi
  done
}

docker_e2e_harness_mount_args() {
  DOCKER_E2E_HARNESS_ARGS=(
    -v "$ROOT_DIR/scripts/e2e:/app/scripts/e2e:ro"
    -v "$ROOT_DIR/scripts/lib:/app/scripts/lib:ro"
    -v "$ROOT_DIR/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro"
  )
}

docker_e2e_run_with_harness() {
  docker_e2e_harness_mount_args
  local run_status=0
  docker_e2e_docker_run_cmd run --rm "${DOCKER_E2E_HARNESS_ARGS[@]}" "$@" || run_status="$?"
  docker_e2e_cleanup_package_mount_args
  return "$run_status"
}

docker_e2e_run_detached_with_harness() {
  docker_e2e_harness_mount_args
  docker_e2e_docker_cmd run -d "${DOCKER_E2E_HARNESS_ARGS[@]}" "$@"
}

docker_e2e_run_logged_with_harness() {
  local label="$1"
  shift
  run_logged "$label" docker_e2e_run_with_harness "$@"
}

docker_e2e_run_logged_print_with_harness() {
  local label="$1"
  shift
  run_logged_print_heartbeat \
    "$label" \
    "${OPENCLAW_DOCKER_E2E_LOG_HEARTBEAT_SECONDS:-30}" \
    docker_e2e_run_with_harness \
    "$@"
}
