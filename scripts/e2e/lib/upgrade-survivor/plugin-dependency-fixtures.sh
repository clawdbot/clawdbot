#!/usr/bin/env bash

# Keep the seeded set across update/Doctor phases: requested plugins may be absent
# from a historical package, while seeded shared state must survive its replacement.
seeded_plugin_dependency_ids=()

plugin_deps_cleanup_enabled() {
  [ "$SCENARIO" = "plugin-deps-cleanup" ]
}

plugin_deps_cleanup_plugins() {
  printf '%s\n' "${OPENCLAW_UPGRADE_SURVIVOR_PLUGIN_DEPS_CLEANUP_PLUGINS:-discord telegram}"
}

plugin_deps_cleanup_plugin_dirs() {
  local plugin="$1"
  printf '%s\n' \
    "$(package_root)/dist/extensions/$plugin" \
    "$(package_root)/extensions/$plugin"
}

legacy_plugin_dependency_probe_paths() {
  local plugin="$1"
  local plugin_dir
  while IFS= read -r plugin_dir; do
    printf '%s\n' \
      "$plugin_dir/node_modules" \
      "$plugin_dir/.openclaw-runtime-deps.json" \
      "$plugin_dir/.openclaw-runtime-deps-stamp.json" \
      "$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor" \
      "$plugin_dir/.openclaw-install-stage-upgrade-survivor" \
      "$plugin_dir/.openclaw-pnpm-store"
  done < <(plugin_deps_cleanup_plugin_dirs "$plugin")
  printf '%s\n' "$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor"
}

install_baseline_plugin_dependencies() {
  plugin_deps_cleanup_enabled || return 0
  echo "Skipping baseline doctor for plugin dependency cleanup scenario; the package update owns package-local cleanup."
}

seed_legacy_plugin_dependency_debris() {
  plugin_deps_cleanup_enabled || return 0

  seeded_plugin_dependency_ids=()
  local plugin
  for plugin in $(plugin_deps_cleanup_plugins); do
    local plugin_dir
    plugin_dir=""
    local candidate_dir
    while IFS= read -r candidate_dir; do
      if [ -d "$candidate_dir" ]; then
        plugin_dir="$candidate_dir"
        break
      fi
    done < <(plugin_deps_cleanup_plugin_dirs "$plugin")
    [ -n "$plugin_dir" ] || continue
    mkdir -p \
      "$plugin_dir/node_modules/openclaw-upgrade-survivor-dep" \
      "$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$plugin_dir/.openclaw-install-stage-upgrade-survivor" \
      "$plugin_dir/.openclaw-pnpm-store" \
      "$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$plugin_dir/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"plugin":"%s","scenario":"plugin-deps-cleanup"}\n' "$plugin" \
      >"$plugin_dir/.openclaw-runtime-deps.json"
    printf '{"plugin":"%s","scenario":"plugin-deps-cleanup","stale":true}\n' "$plugin" \
      >"$plugin_dir/.openclaw-runtime-deps-stamp.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    seeded_plugin_dependency_ids+=("$plugin")
    echo "Seeded legacy plugin dependency debris for configured plugin: $plugin"
  done

  if [ "${#seeded_plugin_dependency_ids[@]}" -eq 0 ]; then
    echo "plugin-deps-cleanup scenario could not find a requested packaged plugin directory" >&2
    find "$(package_root)/dist" -maxdepth 3 -type d 2>/dev/null >&2 || true
    find "$(package_root)/extensions" -maxdepth 2 -type d 2>/dev/null >&2 || true
    return 1
  fi
}

assert_legacy_plugin_dependency_debris_present() {
  plugin_deps_cleanup_enabled || return 0

  local found
  found="$(legacy_plugin_dependency_debris_count)"
  if [ "$found" -eq 0 ]; then
    echo "plugin-deps-cleanup scenario did not create legacy plugin dependency debris" >&2
    return 1
  fi
}

legacy_plugin_dependency_debris_count() {
  local found=0
  local plugin
  for plugin in "${seeded_plugin_dependency_ids[@]}"; do
    local probe
    while IFS= read -r probe; do
      if [ -e "$probe" ] || [ -L "$probe" ]; then
        found=1
      fi
    done < <(legacy_plugin_dependency_probe_paths "$plugin")
  done
  printf '%s\n' "$found"
}

assert_legacy_plugin_dependency_debris_cleaned() {
  plugin_deps_cleanup_enabled || return 0

  local remaining=0
  local plugin
  for plugin in "${seeded_plugin_dependency_ids[@]}"; do
    local probe
    while IFS= read -r probe; do
      if [ -e "$probe" ] || [ -L "$probe" ]; then
        echo "legacy plugin dependency debris survived update/doctor: $probe" >&2
        remaining=1
      fi
    done < <(legacy_plugin_dependency_probe_paths "$plugin")
    local shared_root
    for shared_root in "$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps" "$OPENCLAW_STATE_DIR/plugin-runtime-deps"; do
      local sentinel="$shared_root/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
      if [ ! -f "$sentinel" ]; then
        echo "shared plugin dependency state was removed during update/doctor: $sentinel" >&2
        remaining=1
      fi
    done
  done
  if [ "$remaining" -ne 0 ]; then
    return 1
  fi
  echo "Package-local dependency debris cleaned; shared plugin runtime state preserved."
}
