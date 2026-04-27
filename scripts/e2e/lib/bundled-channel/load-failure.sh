#!/usr/bin/env bash
#
# Runs load-failure isolation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_load_failure_scenario() {
  local run_log
  run_log="$(docker_e2e_run_log bundled-channel-load-failure)"

  echo "Running bundled channel load-failure isolation Docker E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-load-failure.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-load-failure-install.log 2>&1

root="$(package_root)"
plugin_dir="$root/dist/extensions/load-failure-alpha"
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{
  "name": "@openclaw/load-failure-alpha",
  "version": "2026.4.21",
  "private": true,
  "type": "module",
  "openclaw": {
    "extensions": ["./index.js"],
    "setupEntry": "./setup-entry.js"
  }
}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "load-failure-alpha",
  "channels": ["load-failure-alpha"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
JSON
cat >"$plugin_dir/index.js" <<'JS'
export default {
  kind: "bundled-channel-entry",
  id: "load-failure-alpha",
  name: "Load Failure Alpha",
  description: "Load Failure Alpha",
  register() {},
  loadChannelSecrets() {
    globalThis.__loadFailureSecrets = (globalThis.__loadFailureSecrets ?? 0) + 1;
    throw new Error("synthetic channel secrets failure");
  },
  loadChannelPlugin() {
    globalThis.__loadFailurePlugin = (globalThis.__loadFailurePlugin ?? 0) + 1;
    throw new Error("synthetic channel plugin failure");
  }
};
JS
cat >"$plugin_dir/setup-entry.js" <<'JS'
export default {
  kind: "bundled-channel-setup-entry",
  loadSetupSecrets() {
    globalThis.__loadFailureSetupSecrets = (globalThis.__loadFailureSetupSecrets ?? 0) + 1;
    throw new Error("synthetic setup secrets failure");
  },
  loadSetupPlugin() {
    globalThis.__loadFailureSetup = (globalThis.__loadFailureSetup ?? 0) + 1;
    throw new Error("synthetic setup plugin failure");
  }
};
JS

echo "Loading synthetic failing bundled channel through packaged loader..."
(
  cd "$root"
  OPENCLAW_BUNDLED_PLUGINS_DIR="$root/dist/extensions" node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distDir = path.join(root, "dist");
const bundledPath = fs
  .readdirSync(distDir)
  .filter((entry) => /^bundled-[A-Za-z0-9_-]+\.js$/.test(entry))
  .map((entry) => path.join(distDir, entry))
  .find((entry) => fs.readFileSync(entry, "utf8").includes("src/channels/plugins/bundled.ts"));
if (!bundledPath) {
  throw new Error("missing packaged bundled channel loader artifact");
}
const bundled = await import(pathToFileURL(bundledPath));
const oneArgExports = Object.entries(bundled).filter(
  ([, value]) => typeof value === "function" && value.length === 1,
);
if (oneArgExports.length === 0) {
  throw new Error(`missing one-argument bundled loader exports; exports=${Object.keys(bundled).join(",")}`);
}

const id = "load-failure-alpha";
for (let i = 0; i < 2; i += 1) {
  for (const [name, fn] of oneArgExports) {
    try {
      fn(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("synthetic")) {
        throw new Error(`bundled export ${name} leaked synthetic load failure: ${message}`);
      }
    }
  }
}

const counts = {
  plugin: globalThis.__loadFailurePlugin,
  setup: globalThis.__loadFailureSetup,
  secrets: globalThis.__loadFailureSecrets,
  setupSecrets: globalThis.__loadFailureSetupSecrets,
};
for (const [key, value] of Object.entries({
  plugin: counts.plugin,
  setup: counts.setup,
  setupSecrets: counts.setupSecrets,
})) {
  if (value !== 1) {
    throw new Error(`expected ${key} failure to be cached after one load, got ${value}`);
  }
}
if (counts.secrets !== undefined && counts.secrets !== 1) {
  throw new Error(`expected secrets failure to be cached after one load when exercised, got ${counts.secrets}`);
}
console.log("synthetic bundled channel load failures were isolated and cached");
NODE
)

echo "bundled channel load-failure isolation Docker E2E passed"
EOF
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
