#!/usr/bin/env bash

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

  local artifact_script="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_ARTIFACT_SCRIPT:-scripts/prepublish-plugin-registry-artifact.mjs}"
  local server_script="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_SERVER_SCRIPT:-scripts/e2e/lib/plugins/npm-registry-server.mjs}"
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
  local dist_tags="beta=$candidate_version"
  if [[ "$candidate_version" =~ -(alpha|beta)\.[1-9][0-9]*$ ]]; then
    dist_tags="latest=0.0.0,$dist_tags"
  fi
  rm -f "$port_file"
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="$dist_tags" \
    OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
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
  printf -v "$pid_variable" "%s" "$server_pid"
}
