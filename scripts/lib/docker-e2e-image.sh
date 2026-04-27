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
  if [ -z "$target" ] && [ "$dockerfile" = "$ROOT_DIR/scripts/e2e/Dockerfile" ]; then
    # The generic E2E image defaults to the package-installed app image; tests
    # that need a clean install runner pass target=bare explicitly.
    target="functional"
  fi

  if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ] || [ "$skip_build" = "1" ]; then
    echo "Reusing Docker image: $image_name"
    if ! docker image inspect "$image_name" >/dev/null 2>&1; then
      echo "Docker image not found locally; pulling: $image_name"
      if docker pull "$image_name"; then
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
  if [ -n "$target" ]; then
    build_args+=(--target "$target")
  fi
  if [ "$target" = "functional" ]; then
    local package_tgz
    local package_context
    package_tgz="$(docker_e2e_prepare_package_tgz "$label")"
    package_context="$(docker_e2e_prepare_package_context "$package_tgz")"
    # The Dockerfile never sees repo sources as app input; functional installs
    # exactly this tarball through a named BuildKit context.
    build_args+=(--build-context "openclaw_package=$package_context")
  fi
  build_args+=(-t "$image_name" -f "$dockerfile" "$context")
  docker_build_run "$label-build" "${build_args[@]}"
}
