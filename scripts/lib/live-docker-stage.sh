#!/usr/bin/env bash

live_docker_stage_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$live_docker_stage_dir/frozen-target-compat.sh"
unset live_docker_stage_dir

openclaw_live_stage_mounted_auth() {
  if [ "${OPENCLAW_DOCKER_AUTH_PRESTAGED:-0}" = "1" ]; then
    return 0
  fi

  local auth_path
  local auth_dirs=()
  local auth_files=()
  IFS=',' read -r -a auth_dirs <<<"${OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED:-}"
  IFS=',' read -r -a auth_files <<<"${OPENCLAW_DOCKER_AUTH_FILES_RESOLVED:-}"
  if ((${#auth_dirs[@]} > 0)); then
    for auth_path in "${auth_dirs[@]}"; do
      [ -n "$auth_path" ] || continue
      if [ -d "/host-auth/$auth_path" ]; then
        mkdir -p "$HOME/$auth_path"
        cp -R "/host-auth/$auth_path/." "$HOME/$auth_path"
        chmod -R u+rwX "$HOME/$auth_path" || true
      fi
    done
  fi
  if ((${#auth_files[@]} > 0)); then
    for auth_path in "${auth_files[@]}"; do
      [ -n "$auth_path" ] || continue
      if [ -f "/host-auth-files/$auth_path" ]; then
        mkdir -p "$(dirname "$HOME/$auth_path")"
        cp "/host-auth-files/$auth_path" "$HOME/$auth_path"
        chmod u+rw "$HOME/$auth_path" || true
      fi
    done
  fi
}

openclaw_live_stage_gemini_auth() {
  local auth_type="gemini-api-key"
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    [ -n "${GOOGLE_API_KEY:-}" ] || return 0
    auth_type="vertex-ai"
    export GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-true}"
  fi

  # Staged user settings override Gemini's env-based auth selection. Align only
  # the disposable container home with the credentials supplied for this run.
  GEMINI_CLI_AUTH_TYPE="$auth_type" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {}
settings.security = settings.security && typeof settings.security === "object" ? settings.security : {};
settings.security.auth =
  settings.security.auth && typeof settings.security.auth === "object" ? settings.security.auth : {};
settings.security.auth.selectedType = process.env.GEMINI_CLI_AUTH_TYPE;
settings.security.auth.enforcedType = process.env.GEMINI_CLI_AUTH_TYPE;
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
  echo "Using Gemini CLI auth type $auth_type"
}

openclaw_live_run_setup_command() {
  local timeout_seconds="${1:?setup timeout seconds required}"
  local label="${2:?setup label required}"
  shift 2

  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  else
    echo "timeout command not found; cannot bound ${label} after ${timeout_seconds}s" >&2
    return 127
  fi
  if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
    "$timeout_bin" --kill-after=30s "${timeout_seconds}s" "$@"
  else
    "$timeout_bin" "${timeout_seconds}s" "$@"
  fi
}

openclaw_live_prepare_cli_backend() {
  local command_path="${1:?CLI command required}"
  local package="${2:-}"
  local timeout_seconds="${3:?setup timeout required}"
  local pinned=0
  case "$package" in
    @*/*@* | [!@]*@*) pinned=1 ;;
  esac
  if [[ -n "$package" ]] && { [[ ! -x "$(command -v "$command_path" || true)" ]] || ((pinned)); }; then
    openclaw_live_run_setup_command "$timeout_seconds" "live CLI backend setup" npm install -g "$package" || return $?
  fi
  if [[ ! -x "$(command -v "$command_path" || true)" ]]; then
    echo "ERROR: CLI backend executable was not provisioned: $command_path (package=${package:-none})." >&2
    return 127
  fi
}

openclaw_live_prepare_cli_backend_docker_packages() {
  local requested_providers="${1:-}"
  local requested_models="${2:-}"
  local metadata_json

  metadata_json="$(
    OPENCLAW_REQUESTED_PROVIDERS="$requested_providers" \
      OPENCLAW_REQUESTED_MODELS="$requested_models" \
      node --import tsx --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
import path from "node:path";

const modulePath = pathToFileURL(
  path.resolve("scripts/print-cli-backend-live-metadata.ts"),
).href;
const specParserPath = pathToFileURL(path.resolve("src/infra/npm-registry-spec.ts")).href;
const metadata = await import(modulePath);
const specParser = await import(specParserPath);
if (typeof specParser.parseRegistryNpmSpec !== "function") {
  throw new Error("staged target is missing parseRegistryNpmSpec");
}
let result;
if (!Object.prototype.hasOwnProperty.call(metadata, "resolveCliBackendDockerPackages")) {
  result = { kind: "missing-export", packages: [] };
} else {
  if (typeof metadata.resolveCliBackendDockerPackages !== "function") {
    throw new Error("resolveCliBackendDockerPackages export must be a function");
  }
  const splitCsv = (value) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const packages = await metadata.resolveCliBackendDockerPackages(
    splitCsv(process.env.OPENCLAW_REQUESTED_PROVIDERS),
    splitCsv(process.env.OPENCLAW_REQUESTED_MODELS),
  );
  if (!Array.isArray(packages)) {
    throw new Error("resolveCliBackendDockerPackages must return an array");
  }
  const seen = new Set();
  for (const npmPackage of packages) {
    if (typeof npmPackage !== "string" || !specParser.parseRegistryNpmSpec(npmPackage)) {
      throw new Error(`invalid Docker CLI package: ${JSON.stringify(npmPackage)}`);
    }
    if (seen.has(npmPackage)) {
      throw new Error(`duplicate Docker CLI package: ${npmPackage}`);
    }
    seen.add(npmPackage);
  }
  result = { kind: "supported", packages };
}
process.stdout.write(JSON.stringify(result));
NODE
  )" || return $?

  local capability
  capability="$(
    printf '%s' "$metadata_json" | node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !["missing-export", "supported"].includes(value.kind) ||
        !Array.isArray(value.packages)
      ) {
        throw new Error("invalid staged Docker package capability output");
      }
      process.stdout.write(value.kind);
    '
  )" || return $?

  if [[ "$capability" == "missing-export" ]]; then
    local authorization_status
    if openclaw_frozen_target_omissions_authorized; then
      echo "Staged target does not export resolveCliBackendDockerPackages; preserving historical no-package-setup behavior."
      return 0
    else
      authorization_status=$?
    fi
    if ((authorization_status == 2)); then
      return "$authorization_status"
    fi
    echo "staged target does not export resolveCliBackendDockerPackages and frozen-target omissions are not authorized" >&2
    return 1
  fi

  local packages
  packages="$(
    printf '%s' "$metadata_json" | node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      process.stdout.write(value.packages.join("\n"));
    '
  )" || return $?
  while IFS= read -r npm_package; do
    [[ -n "$npm_package" ]] || continue
    openclaw_live_run_setup_command 180 "live CLI backend setup" npm install -g "$npm_package" ||
      return $?
  done <<<"$packages"
}

openclaw_live_resolve_unique_staged_file() {
  local root_dir="${1:?staged root required}"
  local basename="${2:?staged file basename required}"
  if [[ ! -d "$root_dir" ]]; then
    echo "no staged file matched basename: $basename" >&2
    return 1
  fi
  local matches
  matches="$(
    find "$root_dir" \
      \( -path "$root_dir/.git" -o -path "$root_dir/dist" -o -path "$root_dir/node_modules" \) \
      -prune -o -type f -name "$basename" -print |
      LC_ALL=C sort
  )" || return $?

  local count=0
  local match=""
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    count=$((count + 1))
    match="$candidate"
  done <<<"$matches"

  if ((count == 0)); then
    echo "no staged file matched basename: $basename" >&2
    return 1
  fi
  if ((count != 1)); then
    echo "multiple staged files matched basename: $basename" >&2
    return 1
  fi
  printf '%s\n' "${match#"$root_dir"/}"
}

openclaw_live_run_staged_script() {
  local stem="${1:?staged script stem required}"
  shift

  # Frozen candidates may retain the Node-native .mjs runner while current
  # sources ship its .mts successor. Run the candidate's available entrypoint.
  if [ -f "${stem}.mts" ]; then
    node --import tsx "${stem}.mts" "$@"
    return
  fi
  if [ -f "${stem}.mjs" ]; then
    node "${stem}.mjs" "$@"
    return
  fi
  echo "staged OpenClaw script entrypoint not found: ${stem}.{mts,mjs}" >&2
  return 1
}

openclaw_live_stage_source_tree() {
  local dest_dir="${1:?destination directory required}"
  local stage_mode="${OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}"

  if [ "$stage_mode" = "symlink" ]; then
    echo "OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE=symlink is disabled; using copy staging." >&2
  fi

  set +e
  tar -C /src \
    --warning=no-file-changed \
    --ignore-failed-read \
    --exclude=.git \
    --exclude=.artifacts \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=ui/dist \
    --exclude=ui/node_modules \
    --exclude=.pnpm-store \
    --exclude=.tmp \
    --exclude=.tmp-precommit-venv \
    --exclude=.worktrees \
    --exclude=__openclaw_vitest__ \
    --exclude=relay.sock \
    --exclude='*.sock' \
    --exclude='*/*.sock' \
    --exclude='apps/*/.build' \
    --exclude='apps/*/*.bun-build' \
    --exclude='apps/*/.gradle' \
    --exclude='apps/*/.kotlin' \
    --exclude='apps/*/build' \
    -cf - . | tar -C "$dest_dir" -xf -
  local status=$?
  set -e
  if [ "$status" -gt 1 ]; then
    return "$status"
  fi

  local scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
  node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs" "$dest_dir"
}

openclaw_live_link_runtime_tree() {
  local dest_dir="${1:?destination directory required}"

  if [ ! -e "$dest_dir/node_modules" ]; then
    ln -s /app/node_modules "$dest_dir/node_modules"
  fi
  ln -s /app/dist "$dest_dir/dist"
  if [ -d /app/dist-runtime/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist-runtime/extensions
  elif [ -d /app/dist/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist/extensions
  fi
}

openclaw_live_stage_node_modules() {
  local dest_dir="${1:?destination directory required}"
  local target_dir="$dest_dir/node_modules"

  mkdir -p "$target_dir"
  cp -aRs /app/node_modules/. "$target_dir"
  local source_modules staged_modules
  # Source staging excludes node_modules everywhere. Restore each workspace's
  # dependency links too, or package-local imports cannot reach the pnpm store.
  for source_modules in /app/packages/*/node_modules /app/extensions/*/node_modules /app/ui/node_modules; do
    [ -d "$source_modules" ] || continue
    staged_modules="$dest_dir/${source_modules#/app/}"
    [ -d "$(dirname "$staged_modules")" ] || continue
    mkdir -p "$staged_modules"
    cp -aRs "$source_modules/." "$staged_modules"
  done
  rm -rf "$target_dir/.vite-temp"
  mkdir -p "$target_dir/.vite-temp"
}

openclaw_live_scrub_staged_plugin_index() {
  local dest_dir="${1:?destination directory required}"
  local db_path="$dest_dir/state/openclaw.sqlite"

  if [ ! -f "$db_path" ]; then
    return 0
  fi

  node - "$db_path" <<'NODE'
const dbPath = process.argv[2];
let db;
try {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA secure_delete = ON;");
    db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("VACUUM;");
  } catch (err) {
    if (!String(err?.message ?? err).includes("no such table")) {
      throw err;
    }
  }
} finally {
  db?.close();
}
NODE
}

openclaw_live_stage_state_dir() {
  local dest_dir="${1:?destination directory required}"
  local source_dir="${HOME}/.openclaw"

  mkdir -p "$dest_dir"
  if [ -d "$source_dir" ]; then
    # Sandbox workspaces can accumulate root-owned artifacts from prior Docker
    # runs. Persisted plugin registry state contains host-absolute paths that
    # are not portable into Linux containers. Live-test auth/config staging does
    # not need the old JSON source or the SQLite plugins.installedIndex machine-state row.
    set +e
    tar -C "$source_dir" \
      --warning=no-file-changed \
      --ignore-failed-read \
      --exclude=workspace \
      --exclude=sandboxes \
      --exclude=plugins/installs.json \
      --exclude=plugins/installs.json.migrated \
      --exclude=relay.sock \
      --exclude='*.sock' \
      --exclude='*/*.sock' \
      -cf - . | tar -C "$dest_dir" -xf -
    local status=$?
    set -e
    if [ "$status" -gt 1 ]; then
      return "$status"
    fi
    chmod -R u+rwX "$dest_dir" || true
    openclaw_live_scrub_staged_plugin_index "$dest_dir"
    if [ -d "$source_dir/workspace" ] && [ ! -e "$dest_dir/workspace" ]; then
      ln -s "$source_dir/workspace" "$dest_dir/workspace"
    fi
  fi

  export OPENCLAW_STATE_DIR="$dest_dir"
  export OPENCLAW_CONFIG_PATH="$dest_dir/openclaw.json"
}

openclaw_live_prepare_staged_config() {
  if [ ! -f "${OPENCLAW_CONFIG_PATH:-}" ]; then
    return 0
  fi

  local scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
  (
    cd /app
    node --import tsx "$scripts_dir/live-docker-normalize-config.ts"
  )
}
