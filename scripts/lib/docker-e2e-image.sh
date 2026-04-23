#!/usr/bin/env bash

DOCKER_E2E_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${ROOT_DIR:-$(cd "$DOCKER_E2E_LIB_DIR/../.." && pwd)}"

source "$DOCKER_E2E_LIB_DIR/docker-e2e-logs.sh"

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

docker_e2e_build_or_reuse() {
  local image_name="$1"
  local label="$2"
  local dockerfile="${3:-$ROOT_DIR/scripts/e2e/Dockerfile}"
  local context="${4:-$ROOT_DIR}"
  local target="${5:-}"
  local skip_build="${6:-0}"

  if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ] || [ "$skip_build" = "1" ]; then
    echo "Reusing Docker image: $image_name"
    if ! docker image inspect "$image_name" >/dev/null 2>&1; then
      echo "Docker image not found locally; pulling: $image_name"
      if ! docker pull "$image_name"; then
        echo "Docker image not found: $image_name" >&2
        echo "Build it first or unset OPENCLAW_SKIP_DOCKER_BUILD." >&2
        return 1
      fi
    fi
    return 0
  fi

  echo "Building Docker image: $image_name"
  local build_cmd=(docker build)
  if [ -n "$target" ]; then
    build_cmd+=(--target "$target")
  fi
  build_cmd+=(-t "$image_name" -f "$dockerfile" "$context")
  run_logged "$label-build" "${build_cmd[@]}"
}
