#!/usr/bin/env bash
#
# Shared Docker E2E image resolver/builder.
# Suite-specific scripts call this to resolve overrides, reuse pulled images, or
# build the runner/functional images with the prepared OpenClaw package tarball.

DOCKER_E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "$DOCKER_E2E_LIB_DIR/../.." && pwd)}"

source "$DOCKER_E2E_LIB_DIR/docker-e2e-logs.sh"
source "$DOCKER_E2E_LIB_DIR/docker-build.sh"
source "$DOCKER_E2E_LIB_DIR/docker-e2e-package.sh"
source "$DOCKER_E2E_LIB_DIR/docker-e2e-container.sh"

docker_e2e_resolve_image() {
  local default_image="$1"
  shift

  local env_name
  for env_name in "$@"; do
    local value="${!env_name:-}"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done

  if [ -n "${OPENCLAW_DOCKER_E2E_IMAGE:-}" ]; then
    printf '%s\n' "$OPENCLAW_DOCKER_E2E_IMAGE"
    return 0
  fi

  printf '%s\n' "$default_image"
}

docker_e2e_read_nonnegative_decimal_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [ -z "${!name+x}" ]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^(0|[1-9][0-9]*)(\.[0-9]+)?$ ]]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  local integer_part="${value%%.*}"
  local fractional_part=""
  if [[ "$value" == *.* ]]; then
    fractional_part="${value#*.}"
  fi
  # These suite knobs are human-authored resource/time ceilings. Reject
  # pathological decimal strings before Docker setup instead of failing later.
  if [ "${#integer_part}" -gt 9 ] || [ "${#fractional_part}" -gt 6 ]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf '%s\n' "$value"
}

docker_e2e_read_tcp_port_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [ -z "${!name+x}" ]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  local decimal_value=$((10#$value))
  if [ "$decimal_value" -lt 1 ] || [ "$decimal_value" -gt 65535 ]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf '%s\n' "$value"
}

docker_e2e_build_or_reuse() {
  local image_name="$1"
  local label="$2"
  local dockerfile="${3:-$ROOT_DIR/scripts/e2e/Dockerfile}"
  local context="${4:-$ROOT_DIR}"
  local target="${5:-}"
  local skip_build="${6:-0}"
  if [ -z "$target" ] && [ "$dockerfile" = "$ROOT_DIR/scripts/e2e/Dockerfile" ]; then
    # The generic E2E image defaults to the package-installed app image; tests
    # that need a clean install runner pass target=bare explicitly.
    target="functional"
  fi

  if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ] || [ "$skip_build" = "1" ]; then
    echo "Reusing Docker image: $image_name"
    if ! docker_e2e_docker_cmd image inspect "$image_name" >/dev/null 2>&1; then
      if [ "${OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE:-0}" = "1" ]; then
        echo "Required local Docker E2E image not found: $image_name" >&2
        return 1
      fi
      echo "Docker image not found locally; pulling: $image_name"
      if docker_e2e_docker_cmd pull "$image_name"; then
        return 0
      fi
      if docker_build_on_missing_enabled; then
        echo "Docker image not available; building because OPENCLAW_DOCKER_BUILD_ON_MISSING/OPENCLAW_TESTBOX allows fallback."
      else
        echo "Docker image not found: $image_name" >&2
        echo "Build it first or unset OPENCLAW_SKIP_DOCKER_BUILD." >&2
        return 1
      fi
    else
      return 0
    fi
  fi

  echo "Building Docker image: $image_name"
  local build_args=()
  local package_tgz=""
  local package_context=""
  local package_pack_dir=""
  if [ -n "$target" ]; then
    build_args+=(--target "$target")
  fi
  if [ "$target" = "functional" ]; then
    package_tgz="$(docker_e2e_prepare_package_tgz "$label")"
    if [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
      package_pack_dir="$(dirname "$package_tgz")"
    fi
    local context_status=0
    package_context="$(docker_e2e_prepare_package_context "$package_tgz")" || context_status="$?"
    if [ "$context_status" -ne 0 ]; then
      if [ -n "$package_pack_dir" ]; then
        rm -rf "$package_pack_dir"
      fi
      return "$context_status"
    fi
    # The Dockerfile never sees repo sources as app input; functional installs
    # exactly this tarball through a named BuildKit context.
    build_args+=(--build-context "openclaw_package=$package_context")
  fi
  build_args+=(-t "$image_name" -f "$dockerfile" "$context")
  local build_status=0
  docker_build_run "$label-build" "${build_args[@]}" || build_status="$?"
  if [ -n "$package_context" ]; then
    rm -rf "$package_context"
  fi
  if [ -n "$package_pack_dir" ]; then
    rm -rf "$package_pack_dir"
  fi
  return "$build_status"
}

docker_e2e_test_state_shell_b64() {
  local label="${1:?missing test-state label}"
  local scenario="${2:-empty}"
  node "$ROOT_DIR/scripts/lib/openclaw-test-state.mjs" shell \
    --label "$label" \
    --scenario "$scenario" |
    base64 |
    tr -d '\n'
}

docker_e2e_test_state_function_b64() {
  node "$ROOT_DIR/scripts/lib/openclaw-test-state.mjs" shell-function |
    base64 |
    tr -d '\n'
}

docker_e2e_sample_stats_until_exit() {
  local container_name="${1:?missing container name}"
  local docker_pid="${2:?missing docker pid}"
  local stats_log="${3:?missing stats log}"
  local run_log="${4:?missing run log}"
  local label="${5:-Docker E2E}"
  local heartbeat_seconds="${6:-30}"
  local started_at="$SECONDS"
  local last_heartbeat="$SECONDS"

  if ! [[ "$heartbeat_seconds" =~ ^[0-9]+$ ]] || [ "$heartbeat_seconds" -lt 1 ]; then
    heartbeat_seconds="30"
  fi
  heartbeat_seconds="$((10#$heartbeat_seconds))"

  while kill -0 "$docker_pid" 2>/dev/null; do
    if docker_e2e_docker_cmd inspect "$container_name" >/dev/null 2>&1; then
      docker_e2e_docker_cmd stats --no-stream --format '{{json .}}' "$container_name" >>"$stats_log" 2>/dev/null || true
    fi

    if ((SECONDS - last_heartbeat >= heartbeat_seconds)); then
      local elapsed_seconds=$((SECONDS - started_at))
      local log_bytes="0"
      if [ -f "$run_log" ]; then
        log_bytes="$(wc -c <"$run_log" 2>/dev/null || echo 0)"
        log_bytes="${log_bytes//[[:space:]]/}"
      fi
      echo "$label still running (${elapsed_seconds}s elapsed, ${log_bytes} log bytes captured)..."
      last_heartbeat="$SECONDS"
    fi

    sleep 2
  done
}
