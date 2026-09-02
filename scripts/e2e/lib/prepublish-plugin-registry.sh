#!/usr/bin/env bash

openclaw_prepublish_plugin_registry_configure_docker_args() {
  local registry_dir="$1"
  local resolved_registry_dir
  resolved_registry_dir="$(cd "$registry_dir" && pwd)"
  local manifest="$resolved_registry_dir/prepublish-plugin-registry.json"
  if [ ! -f "$manifest" ]; then
    echo "Prepublish plugin registry manifest is missing." >&2
    return 1
  fi

  local source_sha="${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}"
  local candidate_version="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:-}"
  local manifest_sha256="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}"
  source_sha="${source_sha:-$(node -e 'process.stdout.write(require(process.argv[1]).sourceSha)' "$manifest")}"
  candidate_version="${candidate_version:-$(node -e 'process.stdout.write(require(process.argv[1]).candidateVersion)' "$manifest")}"
  if [ -z "$manifest_sha256" ]; then
    manifest_sha256="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$manifest")"
  fi

  OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS=(
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry
    -e OPENCLAW_DOCKER_E2E_SELECTED_SHA="$source_sha"
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION="$candidate_version"
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="$manifest_sha256"
    -v "$resolved_registry_dir:/tmp/openclaw-prepublish-plugin-registry:ro"
    --entrypoint /opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh
  )
}

openclaw_prepublish_plugin_registry_start() {
  local artifact_dir="$1" source_sha="$2" candidate_version="$3"
  local manifest_sha256="$4" registry_root="$5" pid_variable="$6"
  shift 6

  if [[ ! "$pid_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid prerelease plugin registry PID variable: $pid_variable" >&2
    return 1
  fi
  if [ $(( $# % 3 )) -ne 0 ]; then
    echo "Extra prerelease plugin registry packages must be name/version/tarball triples." >&2
    return 1
  fi

  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local artifact_script="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_SCRIPT:-$helper_dir/../../prepublish-plugin-registry-artifact.mjs}"
  local server_script="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_SERVER_SCRIPT:-$helper_dir/plugins/npm-registry-server.mjs}"
  local required_packages_json="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGES_JSON:-[]}" registry_args=()

  if [ -n "$artifact_dir" ]; then
    node "$artifact_script" verify \
      --artifact-dir "$artifact_dir" \
      --source-sha "$source_sha" \
      --candidate-version "$candidate_version" \
      --manifest-sha256 "$manifest_sha256" \
      --required-packages-json "$required_packages_json" >/dev/null

    local manifest="$artifact_dir/prepublish-plugin-registry.json"
    local registry_rows
    local package_name package_version package_tarball
    registry_rows="$(
      PREPUBLISH_PLUGIN_REGISTRY_MANIFEST="$manifest" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = process.env.PREPUBLISH_PLUGIN_REGISTRY_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const entry of manifest.packages) {
  // Root installs use their explicit tarball; baseline selectors stay upstream.
  if (entry.name === "openclaw") continue;
  process.stdout.write(
    `${entry.name}\t${entry.version}\t${path.join(path.dirname(manifestPath), entry.tarball)}\n`,
  );
}
NODE
    )"
    if [ -n "$registry_rows" ]; then
      while IFS=$'\t' read -r package_name package_version package_tarball; do
        registry_args+=("$package_name" "$package_version" "$package_tarball")
      done <<<"$registry_rows"
    fi
  fi

  registry_args+=("$@")
  if [ "${#registry_args[@]}" -eq 0 ]; then
    printf -v "$pid_variable" "%s" ""
    return 0
  fi

  mkdir -p "$registry_root"
  local port_file="$registry_root/port" log_file="$registry_root/server.log"
  local dist_tags="${OPENCLAW_NPM_REGISTRY_DIST_TAGS-}"
  if [ -z "${OPENCLAW_NPM_REGISTRY_DIST_TAGS+x}" ]; then
    dist_tags="beta=$candidate_version"
    if [[ "$candidate_version" =~ -(alpha|beta)\.[1-9][0-9]*$ ]]; then
      dist_tags="latest=0.0.0,$dist_tags"
    fi
  fi
  rm -f "$port_file"
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="$dist_tags" \
    OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM="${artifact_dir:+1}" \
    OPENCLAW_NPM_REGISTRY_UPSTREAM="${OPENCLAW_NPM_REGISTRY_UPSTREAM:-https://registry.npmjs.org}" \
    node "$server_script" "$port_file" "${registry_args[@]}" >"$log_file" 2>&1 &
  local server_pid="$!"

  for _ in $(seq 1 100); do
    if [ -s "$port_file" ]; then
      break
    fi
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      wait "$server_pid" >/dev/null 2>&1 || true
      cat "$log_file" >&2
      return 1
    fi
    sleep 0.1
  done
  if [ ! -s "$port_file" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
    cat "$log_file" >&2
    echo "Timed out waiting for prerelease plugin npm registry." >&2
    return 1
  fi

  export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$port_file")"
  export npm_config_registry="$NPM_CONFIG_REGISTRY"
  export BUN_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY"
  printf -v "$pid_variable" "%s" "$server_pid"
}

# Keep the registry alive for the entire install command, including package
# lifecycle scripts, then reap it before the build layer or proof exits.
openclaw_prepublish_plugin_registry_run_mounted() (
  set -euo pipefail
  local registry_root registry_pid="" command_pid=""
  registry_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-prepublish-registry.XXXXXX")"
  cleanup_registry_command() {
    if [ -n "$command_pid" ]; then
      kill "$command_pid" >/dev/null 2>&1 || true
      wait "$command_pid" >/dev/null 2>&1 || true
    fi
    if [ -n "$registry_pid" ]; then
      kill "$registry_pid" >/dev/null 2>&1 || true
      wait "$registry_pid" >/dev/null 2>&1 || true
    fi
    rm -rf "$registry_root"
  }
  trap cleanup_registry_command EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  # Before lane code selects an update target, published baseline selectors must
  # remain published; exact candidate dependencies are already in the package set.
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="" \
    openclaw_prepublish_plugin_registry_start_mounted "$registry_root" registry_pid '[]'
  if [ -n "$registry_pid" ]; then
    export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL="$NPM_CONFIG_REGISTRY"
  fi
  "$@" <&0 &
  command_pid="$!"
  wait "$command_pid"
)

openclaw_prepublish_plugin_registry_start_mounted() {
  local registry_root="$1" pid_variable="$2" required_packages_json="$3"
  shift 3
  [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] || return 0

  OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGES_JSON="$required_packages_json" \
    openclaw_prepublish_plugin_registry_start \
    "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR" \
    "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:?missing selected SHA}" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:?missing manifest SHA-256}" \
    "$registry_root" \
    "$pid_variable" \
    "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  openclaw_prepublish_plugin_registry_run_mounted "$@"
fi
