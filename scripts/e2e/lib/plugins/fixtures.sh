record_fixture_plugin_trust() {
  local plugin_id="$1"
  local plugin_root="$2"
  local enabled="$3"
  node scripts/e2e/lib/plugins/assertions.mjs record-fixture-plugin-trust "$plugin_id" "$plugin_root" "$enabled"
}

write_fixture_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  mkdir -p "$dir"
  cat >"$dir/package.json" <<JSON
{
  "name": "@openclaw/$id",
  "version": "$version",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
  cat >"$dir/index.js" <<JS
module.exports = {
  id: "$id",
  name: "$name",
  register(api) {
    api.registerGatewayMethod("$method", async () => ({ ok: true }));
  },
};
JS
  cat >"$dir/openclaw.plugin.json" <<'JSON'
{
  "id": "placeholder",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
  node scripts/e2e/lib/plugins/assertions.mjs set-manifest-id "$dir/openclaw.plugin.json" "$id"
}
