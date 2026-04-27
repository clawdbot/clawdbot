#!/usr/bin/env bash
#
# Runs setup-entry runtime-dependency installation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_setup_entry_scenario() {
  local run_log
  run_log="$(docker_e2e_run_log bundled-channel-setup-entry)"

  echo "Running bundled channel setup-entry runtime deps Docker E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-setup-entry.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="$HOME/.openclaw/plugin-runtime-deps"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR"

declare -A SETUP_ENTRY_DEP_SENTINELS=(
  [feishu]="@larksuiteoapi/node-sdk"
  [whatsapp]="@whiskeysockets/baileys"
)

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-setup-entry-install.log 2>&1

root="$(package_root)"
for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  test -d "$root/dist/extensions/$channel"
  if [ -d "$root/dist/extensions/$channel/node_modules" ]; then
    echo "$channel runtime deps should not be preinstalled in package" >&2
    find "$root/dist/extensions/$channel/node_modules" -maxdepth 3 -type f | head -40 >&2 || true
    exit 1
  fi
  if [ -f "$root/node_modules/$dep_sentinel/package.json" ]; then
    echo "$dep_sentinel should not be installed at package root before setup-entry load" >&2
    exit 1
  fi
done

echo "Probing real bundled setup entries before channel configuration..."
(
  cd "$root"
  node --input-type=module - <<'NODE'
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
const setupPluginLoader = Object.values(bundled).find(
  (value) => typeof value === "function" && value.name === "getBundledChannelSetupPlugin",
);
if (!setupPluginLoader) {
  throw new Error("missing packaged getBundledChannelSetupPlugin export");
}
for (const channel of ["feishu", "whatsapp"]) {
  const plugin = setupPluginLoader(channel);
  if (!plugin) {
    throw new Error(`${channel} setup plugin did not load pre-config`);
  }
  if (plugin.id !== channel) {
    throw new Error(`${channel} setup plugin id mismatch: ${plugin.id}`);
  }
  console.log(`${channel} setup plugin loaded pre-config`);
}
NODE
)

for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  if [ -e "$root/dist/extensions/$channel/node_modules/$dep_sentinel/package.json" ]; then
    echo "setup-entry discovery installed $channel deps into bundled plugin tree before channel configuration" >&2
    exit 1
  fi
  if find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$dep_sentinel/package.json" -type f | grep -q .; then
    echo "setup-entry discovery installed $channel external staged deps before channel configuration" >&2
    find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -160 >&2 || true
    exit 1
  fi
done

echo "Running packaged guided WhatsApp setup; runtime deps should be staged before finalize..."
OPENCLAW_PACKAGE_ROOT="$root" node --input-type=module - <<'NODE'
import path from "node:path";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = process.env.OPENCLAW_PACKAGE_ROOT;
if (!root) {
  throw new Error("missing OPENCLAW_PACKAGE_ROOT");
}
const distDir = path.join(root, "dist");
const onboardChannelFiles = (await readdir(distDir))
  .filter((entry) => /^onboard-channels-.*\.js$/.test(entry))
  .sort();
let setupChannels;
for (const entry of onboardChannelFiles) {
  const module = await import(pathToFileURL(path.join(distDir, entry)));
  if (typeof module.setupChannels === "function") {
    setupChannels = module.setupChannels;
    break;
  }
}
if (!setupChannels) {
  throw new Error(
    `could not find packaged setupChannels export in ${JSON.stringify(onboardChannelFiles)}`,
  );
}

let channelSelectCount = 0;
const notes = [];
const prompter = {
  intro: async () => {},
  outro: async () => {},
  note: async (body, title) => {
    notes.push({ title, body });
  },
  confirm: async ({ message, initialValue }) => {
    if (message === "Link WhatsApp now (QR)?") {
      return false;
    }
    return initialValue ?? true;
  },
  select: async ({ message, options }) => {
    if (message === "Select a channel") {
      channelSelectCount += 1;
      return channelSelectCount === 1 ? "whatsapp" : "__done__";
    }
    if (message === "Install WhatsApp plugin?") {
      if (!options?.some((option) => option.value === "local")) {
        throw new Error(`missing bundled local install option: ${JSON.stringify(options)}`);
      }
      return "local";
    }
    if (message === "WhatsApp phone setup") {
      return "separate";
    }
    if (message === "WhatsApp DM policy") {
      return "disabled";
    }
    throw new Error(`unexpected select prompt: ${message}`);
  },
  multiselect: async ({ message }) => {
    throw new Error(`unexpected multiselect prompt: ${message}`);
  },
  text: async ({ message }) => {
    throw new Error(`unexpected text prompt: ${message}`);
  },
};
const runtime = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const result = await setupChannels(
  { plugins: { enabled: true } },
  runtime,
  prompter,
  {
    deferStatusUntilSelection: true,
    skipConfirm: true,
    skipStatusNote: true,
    skipDmPolicyPrompt: true,
    initialSelection: ["whatsapp"],
  },
);

if (!result.channels?.whatsapp) {
  throw new Error(`WhatsApp setup did not write channel config: ${JSON.stringify(result)}`);
}
console.log("packaged guided WhatsApp setup completed");
NODE

if [ -e "$root/dist/extensions/whatsapp/node_modules/@whiskeysockets/baileys/package.json" ]; then
  echo "expected guided WhatsApp setup deps to be installed externally, not into bundled plugin tree" >&2
  exit 1
fi
if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/@whiskeysockets/baileys/package.json" -type f | grep -q .; then
  echo "guided WhatsApp setup did not stage @whiskeysockets/baileys before finalize" >&2
  find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -160 >&2 || true
  exit 1
fi

echo "Configuring setup-entry channels; doctor should now install bundled runtime deps externally..."
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

config.plugins = {
  ...(config.plugins || {}),
  enabled: true,
};
config.channels = {
  ...(config.channels || {}),
  feishu: {
    ...(config.channels?.feishu || {}),
    enabled: true,
  },
  whatsapp: {
    ...(config.channels?.whatsapp || {}),
    enabled: true,
  },
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE

openclaw doctor --non-interactive >/tmp/openclaw-setup-entry-doctor.log 2>&1

for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  if [ -e "$root/dist/extensions/$channel/node_modules/$dep_sentinel/package.json" ]; then
    echo "expected configured $channel deps to be installed externally, not into bundled plugin tree" >&2
    exit 1
  fi
  if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$dep_sentinel/package.json" -type f | grep -q .; then
    echo "missing external staged dependency sentinel for configured $channel: $dep_sentinel" >&2
    cat /tmp/openclaw-setup-entry-doctor.log >&2
    find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -160 >&2 || true
    exit 1
  fi
done

echo "bundled channel setup-entry runtime deps Docker E2E passed"
EOF
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
