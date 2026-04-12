#!/usr/bin/env bash

openclaw_live_stage_source_tree() {
  local dest_dir="${1:?destination directory required}"

  set +e
  tar -C /src \
    --warning=no-file-changed \
    --ignore-failed-read \
    --exclude=.git \
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
}

openclaw_live_link_runtime_tree() {
  local dest_dir="${1:?destination directory required}"

  ln -s /app/node_modules "$dest_dir/node_modules"
  ln -s /app/dist "$dest_dir/dist"
  if [ -d /app/dist-runtime/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist-runtime/extensions
  elif [ -d /app/dist/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist/extensions
  fi
}

openclaw_live_stage_state_dir() {
  local dest_dir="${1:?destination directory required}"
  local source_dir="${HOME}/.openclaw"

  mkdir -p "$dest_dir"
  if [ -d "$source_dir" ]; then
    # Sandbox workspaces can accumulate root-owned artifacts from prior Docker
    # runs. They are not needed for live-test auth/config staging and can make
    # temp-dir cleanup fail on exit, so keep them out of the staged state copy.
    set +e
    tar -C "$source_dir" \
      --warning=no-file-changed \
      --ignore-failed-read \
      --exclude=workspace \
      --exclude=sandboxes \
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

  (
    cd /app
    node --import tsx /src/scripts/live-docker-normalize-config.ts
  )
}
