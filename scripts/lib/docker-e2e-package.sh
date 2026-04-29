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
  package_tgz="$(
    node "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" \
      --output-dir "$pack_dir" \
      --output-name openclaw-current.tgz
  )"
  if [ -z "$package_tgz" ]; then
    echo "missing packed OpenClaw tarball" >&2
    return 1
  fi
  docker_e2e_abs_path "$package_tgz"
}

docker_e2e_prepare_package_context() {
  local package_tgz="$1"
  local context_dir
  context_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-docker-e2e-package-context.XXXXXX")"
  # BuildKit named contexts must be directories, so expose the tarball as a
  # stable filename inside a tiny temporary context.
  cp "$package_tgz" "$context_dir/openclaw-current.tgz"
  printf '%s\n' "$context_dir"
}

docker_e2e_package_mount_args() {
  local package_tgz="$1"
  local target="${2:-/tmp/openclaw-current.tgz}"
  DOCKER_E2E_PACKAGE_ARGS=(-v "$package_tgz:$target:ro" -e "OPENCLAW_CURRENT_PACKAGE_TGZ=$target")
}

docker_e2e_harness_mount_args() {
  DOCKER_E2E_HARNESS_ARGS=(-v "$ROOT_DIR/scripts/e2e:/app/scripts/e2e:ro" -v "$ROOT_DIR/scripts/lib:/app/scripts/lib:ro")
}

docker_e2e_run_with_harness() {
  docker_e2e_harness_mount_args
  docker run --rm "${DOCKER_E2E_HARNESS_ARGS[@]}" "$@"
}

docker_e2e_run_detached_with_harness() {
  docker_e2e_harness_mount_args
  docker run -d "${DOCKER_E2E_HARNESS_ARGS[@]}" "$@"
}

docker_e2e_run_logged_with_harness() {
  local label="$1"
  shift
  run_logged "$label" docker_e2e_run_with_harness "$@"
}
