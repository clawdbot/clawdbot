#!/usr/bin/env bash
#
# Container-side helpers shared by bundled channel Docker E2E scenarios.
# These functions assume the OpenClaw package is installed globally inside the
# test container and the scenario has exported HOME/OPENAI_API_KEY as needed.

bundled_channel_package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

bundled_channel_stage_root() {
  printf "%s/.openclaw/plugin-runtime-deps" "$HOME"
}

bundled_channel_stage_dir() {
  printf "%s" "${OPENCLAW_PLUGIN_STAGE_DIR:-$(bundled_channel_stage_root)}"
}

bundled_channel_install_package() {
  openclaw_e2e_install_package "$@"
}

bundled_channel_find_external_dep_package() {
  local dep_path="$1"
  find "$(bundled_channel_stage_root)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

bundled_channel_find_staged_dep_package() {
  local dep_path="$1"
  find "$(bundled_channel_stage_dir)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

bundled_channel_dump_stage_dir() {
  find "$(bundled_channel_stage_dir)" -maxdepth 12 -type f | sort | head -160 >&2 || true
}

bundled_channel_assert_no_package_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  for candidate in \
    "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$root/dist/extensions/node_modules/$dep_path/package.json" \
    "$root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      echo "packaged install should not mutate package tree for $channel: $candidate" >&2
      exit 1
    fi
  done
  if [ -f "$HOME/node_modules/$dep_path/package.json" ]; then
    echo "bundled runtime deps should not use HOME npm project for $channel: $HOME/node_modules/$dep_path/package.json" >&2
    exit 1
  fi
}

bundled_channel_assert_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  if [ -n "$(bundled_channel_find_external_dep_package "$dep_path")" ]; then
    bundled_channel_assert_no_package_dep_available "$channel" "$dep_path" "$root"
    return 0
  fi
  echo "missing dependency sentinel for $channel: $dep_path" >&2
  find "$root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
  find "$root/node_modules" -maxdepth 3 -path "*/$dep_path/package.json" -type f -print >&2 || true
  find "$(bundled_channel_stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
  exit 1
}

bundled_channel_assert_no_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_path" "$root"
  if [ -n "$(bundled_channel_find_external_dep_package "$dep_path")" ]; then
    echo "dependency sentinel should be absent before repair for $channel: $dep_path" >&2
    exit 1
  fi
}

bundled_channel_assert_no_staged_dep() {
  local channel="$1"
  local dep_path="$2"
  local message="${3:-$channel unexpectedly staged $dep_path}"
  if [ -n "$(bundled_channel_find_staged_dep_package "$dep_path")" ]; then
    echo "$message" >&2
    bundled_channel_dump_stage_dir
    exit 1
  fi
}

bundled_channel_assert_staged_dep() {
  local channel="$1"
  local dep_path="$2"
  local log_file="${3:-}"
  if [ -n "$(bundled_channel_find_staged_dep_package "$dep_path")" ]; then
    return 0
  fi
  echo "missing external staged dependency sentinel for $channel: $dep_path" >&2
  if [ -n "$log_file" ]; then
    cat "$log_file" >&2 || true
  fi
  bundled_channel_dump_stage_dir
  exit 1
}

bundled_channel_assert_no_staged_manifest_spec() {
  local channel="$1"
  local dep_path="$2"
  local log_file="${3:-}"
  if ! node scripts/e2e/lib/bundled-channel/assert-no-staged-manifest-spec.mjs "$(bundled_channel_stage_dir)" "$dep_path"; then
    echo "$channel unexpectedly selected $dep_path for external runtime deps" >&2
    if [ -n "$log_file" ]; then
      cat "$log_file" >&2 || true
    fi
    exit 1
  fi
}

bundled_channel_remove_runtime_dep() {
  local channel="$1"
  local dep_path="$2"
  local root="${3:-$(bundled_channel_package_root)}"
  rm -rf "$root/dist/extensions/$channel/node_modules"
  rm -rf "$root/dist/extensions/node_modules/$dep_path"
  rm -rf "$root/node_modules/$dep_path"
  rm -rf "$(bundled_channel_stage_root)"
}

bundled_channel_write_config() {
  local mode="$1"
  node scripts/e2e/lib/bundled-channel/write-config.mjs \
    "$mode" \
    "${TOKEN:-bundled-channel-config-token}" \
    "${PORT:-18789}"
}
