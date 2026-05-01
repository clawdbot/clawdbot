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

write_claude_bundle_fixture() {
  local bundle_root="$1"

  node scripts/e2e/lib/fixture.mjs claude-bundle "$bundle_root"
}
