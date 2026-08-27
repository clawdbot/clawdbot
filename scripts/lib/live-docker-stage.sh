#!/usr/bin/env bash

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
