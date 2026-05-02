record_fixture_plugin_trust() {
  local plugin_id="$1"
  local plugin_root="$2"
  local enabled="$3"
  node scripts/e2e/lib/plugins/assertions.mjs record-fixture-plugin-trust "$plugin_id" "$plugin_root" "$enabled"
}

write_demo_fixture_plugin() {
  local dir="$1"
  node scripts/e2e/lib/fixture.mjs plugin-demo "$dir"
}

write_fixture_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  node scripts/e2e/lib/fixture.mjs plugin "$dir" "$id" "$version" "$method" "$name"
}

write_fixture_plugin_with_cli() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"
  local cli_root="$6"
  local cli_output="$7"

  node scripts/e2e/lib/fixture.mjs plugin-cli "$dir" "$id" "$version" "$method" "$name" "$cli_root" "$cli_output"
}

pack_fixture_plugin_with_cli_registry_dependency() {
  local pack_dir="$1"
  local output_tgz="$2"
  local id="$3"
  local version="$4"
  local method="$5"
  local name="$6"
  local cli_root="$7"
  local cli_output="$8"

  mkdir -p "$pack_dir/package"
  node scripts/e2e/lib/fixture.mjs plugin-cli-registry-dep "$pack_dir/package" "$id" "$version" "$method" "$name" "$cli_root" "$cli_output"
  tar -czf "$output_tgz" -C "$pack_dir" package
}

pack_fake_is_number_package() {
  local pack_dir="$1"
  local output_tgz="$2"

  mkdir -p "$pack_dir/package"
  node scripts/e2e/lib/fixture.mjs fake-is-number-package "$pack_dir/package"
  tar -czf "$output_tgz" -C "$pack_dir" package
}

write_fixture_plugin_with_vendored_dependency() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  node scripts/e2e/lib/fixture.mjs plugin-vendored-dep "$dir" "$id" "$version" "$method" "$name"
}

write_fixture_manifest() {
  local file="$1"
  local id="$2"

  node scripts/e2e/lib/fixture.mjs plugin-manifest "$file" "$id"
}

pack_fixture_plugin() {
  local pack_dir="$1"
  local output_tgz="$2"
  local id="$3"
  local version="$4"
  local method="$5"
  local name="$6"

  mkdir -p "$pack_dir/package"
  write_fixture_plugin "$pack_dir/package" "$id" "$version" "$method" "$name"
  tar -czf "$output_tgz" -C "$pack_dir" package
}

start_npm_fixture_registry() {
  local package_name="$1"
  local version="$2"
  local tarball="$3"
  local fixture_dir="$4"
  local server_log="$fixture_dir/npm-registry.log"
  local server_port_file="$fixture_dir/npm-registry-port"
  local server_pid_file="$fixture_dir/npm-registry-pid"

  shift 4

  node scripts/e2e/lib/plugins/npm-registry-server.mjs "$server_port_file" "$package_name" "$version" "$tarball" "$@" >"$server_log" 2>&1 &
  local server_pid="$!"
  echo "$server_pid" >"$server_pid_file"

  for _ in $(seq 1 100); do
    if [[ -s "$server_port_file" ]]; then
      export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$server_port_file")"
      trap 'if [[ -f "'"$server_pid_file"'" ]]; then kill "$(cat "'"$server_pid_file"'")" 2>/dev/null || true; fi' EXIT
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "$server_log"
      return 1
    fi
    sleep 0.1
  done

  cat "$server_log"
  echo "Timed out waiting for npm fixture registry." >&2
  return 1
}

write_claude_bundle_fixture() {
  local bundle_root="$1"

  node scripts/e2e/lib/fixture.mjs claude-bundle "$bundle_root"
}
