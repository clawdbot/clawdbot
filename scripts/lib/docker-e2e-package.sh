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
if ! declare -F docker_e2e_docker_cmd >/dev/null 2>&1 || \
  ! declare -F docker_e2e_docker_run_cmd >/dev/null 2>&1; then
  source "$DOCKER_E2E_PACKAGE_LIB_DIR/docker-e2e-container.sh"
fi

docker_e2e_abs_path() {
  local file="$1"
  (cd "$(dirname "$file")" && printf '%s/%s\n' "$(pwd)" "$(basename "$file")")
}

docker_e2e_restore_package_dist_from_image() (
  local image="$1"
  local ai_backup_dir=""
  local ai_dist_dir=""
  local ai_dist_installed=0
  local ai_package_dir=""
  local backup_dir=""
  local container_id=""
  local dist_installed=0
  local requires_ai_dist=0
  local restore_root=""
  local restore_complete=0
  local temp_dir=""

  cleanup_restore_package_dist() {
    if [ -n "$container_id" ]; then
      docker_e2e_docker_cmd rm -f "$container_id" >/dev/null 2>&1 || true
    fi
    # Root and AI artifacts come from one image. Restore both on partial failure
    # so the package step cannot combine outputs from different builds.
    if [ "$restore_complete" != "1" ]; then
      if [ "$dist_installed" = "1" ]; then
        rm -rf "$restore_root/dist" >/dev/null 2>&1 || true
      fi
      if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
        if [ ! -e "$restore_root/dist" ] && \
          mv "$backup_dir" "$restore_root/dist" >/dev/null 2>&1; then
          backup_dir=""
        fi
      fi
      if [ "$ai_dist_installed" = "1" ]; then
        rm -rf "$ai_dist_dir" >/dev/null 2>&1 || true
      fi
      if [ -n "$ai_backup_dir" ] && [ -d "$ai_backup_dir" ]; then
        if [ ! -e "$ai_dist_dir" ] && \
          mv "$ai_backup_dir" "$ai_dist_dir" >/dev/null 2>&1; then
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

  if ! restore_root="$(cd "$ROOT_DIR" && pwd -P)"; then
    echo "unable to resolve package restore root: $ROOT_DIR" >&2
    return 1
  fi
  # The trusted workflow owns this static checkout and runs no candidate process
  # concurrently. Resolve owner paths once and reuse them through every swap.
  if [ -L "$restore_root/packages" ] || [ -L "$restore_root/packages/ai" ]; then
    echo "refusing package artifact restore through a symlinked packages path" >&2
    return 1
  fi
  if [ -f "$restore_root/packages/ai/package.json" ]; then
    if ! ai_package_dir="$(cd "$restore_root/packages/ai" && pwd -P)"; then
      echo "unable to resolve bundled AI package path" >&2
      return 1
    fi
    case "$ai_package_dir/" in
      "$restore_root"/*) ;;
      *)
        echo "refusing bundled AI artifact restore outside the package root" >&2
        return 1
        ;;
    esac
    ai_dist_dir="$ai_package_dir/dist"
    requires_ai_dist=1
  fi

  echo "==> Reuse package build artifacts from Docker image: $image"
  if ! container_id="$(docker_e2e_docker_cmd create "$image")"; then
    cleanup_restore_package_dist
    return 1
  fi
  if ! temp_dir="$(mktemp -d "$restore_root/.package-dist.XXXXXX")"; then
    cleanup_restore_package_dist
    return 1
  fi
  if ! docker_e2e_docker_cmd cp "${container_id}:/app/dist" "$temp_dir/dist"; then
    cleanup_restore_package_dist
    return 1
  fi
  if [ "$requires_ai_dist" = "1" ] && \
    ! docker_e2e_docker_cmd cp \
      "${container_id}:/app/node_modules/@openclaw/ai/dist" \
      "$temp_dir/ai-dist"; then
    cleanup_restore_package_dist
    return 1
  fi
  if [ -e "$restore_root/dist" ]; then
    if ! backup_dir="$(mktemp -d "$restore_root/.dist-backup.XXXXXX")"; then
      cleanup_restore_package_dist
      return 1
    fi
    if ! rmdir "$backup_dir"; then
      cleanup_restore_package_dist
      return 1
    fi
    if ! mv "$restore_root/dist" "$backup_dir"; then
      cleanup_restore_package_dist
      return 1
    fi
  fi
  if ! mv "$temp_dir/dist" "$restore_root/dist"; then
    cleanup_restore_package_dist
    return 1
  fi
  dist_installed=1
  if [ "$requires_ai_dist" = "1" ]; then
    if [ -e "$ai_dist_dir" ]; then
      if ! ai_backup_dir="$(mktemp -d "$ai_package_dir/.dist-backup.XXXXXX")"; then
        cleanup_restore_package_dist
        return 1
      fi
      if ! rmdir "$ai_backup_dir"; then
        cleanup_restore_package_dist
        return 1
      fi
      if ! mv "$ai_dist_dir" "$ai_backup_dir"; then
        cleanup_restore_package_dist
        return 1
      fi
    fi
    if ! mv "$temp_dir/ai-dist" "$ai_dist_dir"; then
      cleanup_restore_package_dist
      return 1
    fi
    ai_dist_installed=1
  fi
  restore_complete=1
  cleanup_restore_package_dist
)

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
      --allow-unreleased-changelog \
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

docker_e2e_cleanup_container_cidfile() {
  local cidfile="${1:-}"
  [ -n "$cidfile" ] || return 0
  if [ -f "$cidfile" ]; then
    local container_id
    container_id="$(head -n 1 "$cidfile" 2>/dev/null || true)"
    if [ -n "$container_id" ]; then
      docker_e2e_docker_cmd rm -f "$container_id" >/dev/null 2>&1 || true
    fi
    rm -f "$cidfile"
  fi
}

docker_e2e_harness_mount_args() {
  local harness_root="${DOCKER_E2E_HARNESS_ROOT_DIR:-$ROOT_DIR}"
  DOCKER_E2E_HARNESS_ARGS=(
    -v "$harness_root/scripts/e2e:/app/scripts/e2e:ro"
    -v "$harness_root/scripts/lib:/app/scripts/lib:ro"
    -v "$harness_root/packages/gateway-client/src:/app/packages/gateway-client/src:ro"
    -v "$harness_root/packages/normalization-core/package.json:/app/packages/normalization-core/package.json:ro"
    -v "$harness_root/packages/normalization-core/src:/app/packages/normalization-core/src:ro"
    -v "$harness_root/tsconfig.json:/app/tsconfig.json:ro"
    -v "$harness_root/test/e2e/qa-lab:/app/test/e2e/qa-lab:ro"
    -v "$harness_root/test/helpers:/app/test/helpers:ro"
    -v "$harness_root/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro"
  )
}

docker_e2e_run_with_harness() {
  docker_e2e_harness_mount_args
  local run_status=0
  local cid_dir
  local cidfile
  local docker_run_pid=""
  local harness_stdin_fd=""
  local cleanup_done=0
  local previous_int_trap
  local previous_term_trap
  local previous_hup_trap
  cid_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-docker-e2e-container.XXXXXX")"
  cidfile="$cid_dir/container.cid"
  previous_int_trap="$(trap -p INT || true)"
  previous_term_trap="$(trap -p TERM || true)"
  previous_hup_trap="$(trap -p HUP || true)"
  restore_harness_traps() {
    if [ -n "$previous_int_trap" ]; then
      eval "$previous_int_trap"
    else
      trap - INT
    fi
    if [ -n "$previous_term_trap" ]; then
      eval "$previous_term_trap"
    else
      trap - TERM
    fi
    if [ -n "$previous_hup_trap" ]; then
      eval "$previous_hup_trap"
    else
      trap - HUP
    fi
  }
  docker_e2e_harness_descendant_pids() {
    local parent_pid="$1"
    local child_pid
    for child_pid in $(pgrep -P "$parent_pid" 2>/dev/null || true); do
      docker_e2e_harness_descendant_pids "$child_pid"
      printf '%s\n' "$child_pid"
    done
  }
  terminate_harness_docker_run() {
    [ -n "$docker_run_pid" ] || return 0
    kill -0 "$docker_run_pid" 2>/dev/null || return 0
    local descendant_pids
    descendant_pids="$(docker_e2e_harness_descendant_pids "$docker_run_pid")"
    if [ -n "$descendant_pids" ]; then
      kill -TERM $descendant_pids 2>/dev/null || true
    fi
    kill -TERM "$docker_run_pid" 2>/dev/null || true
    local grace_seconds="${OPENCLAW_DOCKER_E2E_CONTAINER_TERM_GRACE_SECONDS:-10}"
    if ! [[ "$grace_seconds" =~ ^[0-9]+$ ]] || [ "$grace_seconds" -lt 1 ]; then
      grace_seconds="10"
    else
      grace_seconds="$((10#$grace_seconds))"
    fi
    local wait_attempt
    for wait_attempt in $(seq 1 "$((grace_seconds * 10))"); do
      if ! kill -0 "$docker_run_pid" 2>/dev/null; then
        return 0
      fi
      /bin/sleep 0.1
    done
    descendant_pids="$(docker_e2e_harness_descendant_pids "$docker_run_pid")"
    if [ -n "$descendant_pids" ]; then
      kill -KILL $descendant_pids 2>/dev/null || true
    fi
    kill -KILL "$docker_run_pid" 2>/dev/null || true
  }
  cleanup_harness_run() {
    local cleanup_status="${1:-$?}"
    local exit_after_cleanup="${2:-0}"
    if [ "$cleanup_done" = "1" ]; then
      if [ "$exit_after_cleanup" = "1" ]; then
        exit "$cleanup_status"
      fi
      return "$cleanup_status"
    fi
    cleanup_done=1
    trap - INT TERM HUP
    terminate_harness_docker_run
    wait "$docker_run_pid" 2>/dev/null || true
    docker_e2e_cleanup_container_cidfile "$cidfile"
    rmdir "$cid_dir" 2>/dev/null || true
    docker_e2e_cleanup_package_mount_args
    if [ -n "$harness_stdin_fd" ]; then
      eval "exec ${harness_stdin_fd}<&-"
    fi
    restore_harness_traps
    if [ "$exit_after_cleanup" = "1" ]; then
      exit "$cleanup_status"
    fi
    return "$cleanup_status"
  }
  trap 'cleanup_harness_run 130 1' INT
  trap 'cleanup_harness_run 143 1' TERM
  trap 'cleanup_harness_run 129 1' HUP
  local candidate_fd
  for candidate_fd in 19 18 17 16 15 14 13 12 11 10; do
    if ! eval "true <&${candidate_fd}" 2>/dev/null; then
      harness_stdin_fd="$candidate_fd"
      break
    fi
  done
  if [ -z "$harness_stdin_fd" ]; then
    echo "no free file descriptor available for Docker harness stdin" >&2
    cleanup_harness_run 1
    return 1
  fi
  eval "exec ${harness_stdin_fd}<&0"
  docker_e2e_docker_run_cmd run --rm --cidfile "$cidfile" "${DOCKER_E2E_HARNESS_ARGS[@]}" "$@" <&$harness_stdin_fd &
  docker_run_pid="$!"
  local had_errexit=0
  case "$-" in
    *e*)
      had_errexit=1
      ;;
  esac
  set +e
  wait "$docker_run_pid"
  run_status="$?"
  if [ "$had_errexit" = "1" ]; then
    set -e
  fi
  cleanup_harness_run 0
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
  local heartbeat_seconds
  heartbeat_seconds="$(docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_HEARTBEAT_SECONDS 30)" || return $?
  run_logged_print_heartbeat \
    "$label" \
    "$heartbeat_seconds" \
    docker_e2e_run_with_harness \
    "$@"
}
