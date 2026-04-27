#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-bundled-plugin-install-uninstall-e2e" OPENCLAW_BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_IMAGE)"

docker_e2e_build_or_reuse "$IMAGE_NAME" bundled-plugin-install-uninstall

DOCKER_ENV_ARGS=(-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0)
for env_name in \
  OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL \
  OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX \
  OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS; do
  env_value="${!env_name:-}"
  if [[ -n "$env_value" && "$env_value" != "undefined" && "$env_value" != "null" ]]; then
    DOCKER_ENV_ARGS+=(-e "$env_name")
  fi
done

echo "Running bundled plugin install/uninstall Docker E2E..."
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-plugin-install-uninstall.XXXXXX")"
if ! docker run --rm "${DOCKER_ENV_ARGS[@]}" -i "$IMAGE_NAME" bash -s >"$RUN_LOG" 2>&1 <<'EOF'
set -euo pipefail

if [ -f dist/index.mjs ]; then
  OPENCLAW_ENTRY="dist/index.mjs"
elif [ -f dist/index.js ]; then
  OPENCLAW_ENTRY="dist/index.js"
else
  echo "Missing dist/index.(m)js (build output):"
  ls -la dist || true
  exit 1
fi
export OPENCLAW_ENTRY

home_dir=$(mktemp -d "/tmp/openclaw-bundled-plugin-sweep.XXXXXX")
export HOME="$home_dir"

node - <<'NODE' > /tmp/bundled-plugin-sweep-ids
const fs = require("node:fs");
const path = require("node:path");

const explicit = (process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS || "")
  .split(/[,\s]+/u)
  .map((entry) => entry.trim())
  .filter(Boolean);
const extensionRoot = path.join(process.cwd(), "dist", "extensions");
const manifestEntries = fs
  .readdirSync(extensionRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const manifestPath = path.join(extensionRoot, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!id) {
      throw new Error(`Bundled plugin manifest is missing id: ${manifestPath}`);
    }
    const required = manifest.configSchema?.required;
    return {
      id,
      dir: entry.name,
      requiresConfig:
        Array.isArray(required) && required.some((value) => typeof value === "string"),
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.id.localeCompare(b.id));
const allEntries =
  explicit.length > 0
    ? explicit.map(
        (lookup) =>
          manifestEntries.find((entry) => entry.id === lookup || entry.dir === lookup) || {
            id: lookup,
            dir: lookup,
            requiresConfig: false,
          },
      )
    : manifestEntries;

const total = Number.parseInt(process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL || "1", 10);
const index = Number.parseInt(process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX || "0", 10);
if (!Number.isInteger(total) || total < 1) {
  throw new Error(`OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL must be >= 1, got ${process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL}`);
}
if (!Number.isInteger(index) || index < 0 || index >= total) {
  throw new Error(`OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX must be in [0, ${total - 1}], got ${process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX}`);
}

const selected = allEntries.filter((_, candidateIndex) => candidateIndex % total === index);
if (selected.length === 0) {
  throw new Error(`No bundled plugin ids selected for shard ${index}/${total}`);
}

for (const entry of selected) {
  console.log(`${entry.id}\t${entry.dir}\t${entry.requiresConfig ? "1" : "0"}`);
}
NODE

mapfile -t plugin_entries < /tmp/bundled-plugin-sweep-ids
selected_labels=()
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir _requires_config <<<"$plugin_entry"
  selected_labels+=("${plugin_id}@${plugin_dir}")
done
echo "Selected ${#plugin_entries[@]} bundled plugins for shard ${OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX:-0}/${OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL:-1}: ${selected_labels[*]}"

assert_installed() {
  local plugin_id="$1"
  local plugin_dir="$2"
  local requires_config="$3"
  node - <<'NODE' "$plugin_id" "$plugin_dir" "$requires_config"
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.argv[2];
const pluginDir = process.argv[3];
const requiresConfig = process.argv[4] === "1";
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const records = index.installRecords ?? index.records ?? {};
const record = records[pluginId];
if (!record) {
  throw new Error(`missing install record for ${pluginId}`);
}
if (record.source !== "path") {
  throw new Error(`expected bundled install record source=path for ${pluginId}, got ${record.source}`);
}
if (typeof record.sourcePath !== "string" || !record.sourcePath.includes(`/dist/extensions/${pluginDir}`)) {
  throw new Error(`unexpected bundled source path for ${pluginId}: ${record.sourcePath}`);
}
if (record.installPath !== record.sourcePath) {
  throw new Error(`bundled install path should equal source path for ${pluginId}`);
}
const paths = config.plugins?.load?.paths || [];
if (!paths.includes(record.sourcePath)) {
  throw new Error(`config load paths do not include bundled install path for ${pluginId}`);
}
if (requiresConfig && config.plugins?.entries?.[pluginId]?.enabled === true) {
  throw new Error(`plugin requiring config should not be enabled immediately after install for ${pluginId}`);
}
if (!requiresConfig && config.plugins?.entries?.[pluginId]?.enabled !== true) {
  throw new Error(`config entry is not enabled after install for ${pluginId}`);
}
const allow = config.plugins?.allow || [];
if (Array.isArray(allow) && allow.length > 0 && !allow.includes(pluginId)) {
  throw new Error(`existing allowlist does not include ${pluginId} after install`);
}
if ((config.plugins?.deny || []).includes(pluginId)) {
  throw new Error(`denylist contains ${pluginId} after install`);
}
NODE
}

assert_uninstalled() {
  local plugin_id="$1"
  local plugin_dir="$2"
  node - <<'NODE' "$plugin_id" "$plugin_dir"
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.argv[2];
const pluginDir = process.argv[3];
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};
const records = index.installRecords ?? index.records ?? {};
if (records[pluginId]) {
  throw new Error(`install record still present after uninstall for ${pluginId}`);
}
const paths = config.plugins?.load?.paths || [];
if (paths.some((entry) => String(entry).includes(`/dist/extensions/${pluginDir}`))) {
  throw new Error(`load path still present after uninstall for ${pluginId}`);
}
if (config.plugins?.entries?.[pluginId]) {
  throw new Error(`config entry still present after uninstall for ${pluginId}`);
}
if ((config.plugins?.allow || []).includes(pluginId)) {
  throw new Error(`allowlist still contains ${pluginId} after uninstall`);
}
if ((config.plugins?.deny || []).includes(pluginId)) {
  throw new Error(`denylist still contains ${pluginId} after uninstall`);
}
const managedPath = path.join(process.env.HOME, ".openclaw", "extensions", pluginId);
if (fs.existsSync(managedPath)) {
  throw new Error(`managed install directory unexpectedly exists for bundled plugin ${pluginId}: ${managedPath}`);
}
NODE
}

plugin_index=0
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir requires_config <<<"$plugin_entry"
  install_log="/tmp/openclaw-install-${plugin_index}.log"
  uninstall_log="/tmp/openclaw-uninstall-${plugin_index}.log"
  echo "Installing bundled plugin: $plugin_id ($plugin_dir)"
  node "$OPENCLAW_ENTRY" plugins install "$plugin_id" >"$install_log" 2>&1 || {
    cat "$install_log"
    exit 1
  }
  assert_installed "$plugin_id" "$plugin_dir" "$requires_config"

  echo "Uninstalling bundled plugin: $plugin_id ($plugin_dir)"
  node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force >"$uninstall_log" 2>&1 || {
    cat "$uninstall_log"
    exit 1
  }
  assert_uninstalled "$plugin_id" "$plugin_dir"
  plugin_index=$((plugin_index + 1))
done

echo "bundled plugin install/uninstall sweep passed (${#plugin_entries[@]} plugin(s))"
EOF
then
  cat "$RUN_LOG"
  rm -f "$RUN_LOG"
  exit 1
fi
cat "$RUN_LOG"
rm -f "$RUN_LOG"

echo "OK"
