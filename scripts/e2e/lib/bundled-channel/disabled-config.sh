#!/usr/bin/env bash
#
# Runs disabled-config runtime-dependency isolation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_disabled_config_scenario() {
  local run_log
  run_log="$(docker_e2e_run_log bundled-channel-disabled-config)"

  echo "Running bundled channel disabled-config runtime deps Docker E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-disabled-config.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="$HOME/.openclaw/plugin-runtime-deps"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

assert_dep_absent_everywhere() {
  local channel="$1"
  local dep_path="$2"
  local root="$3"
  for candidate in \
    "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$root/dist/extensions/node_modules/$dep_path/package.json" \
    "$root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      echo "disabled $channel unexpectedly installed $dep_path at $candidate" >&2
      exit 1
    fi
  done

  if ! node - <<'NODE' "$OPENCLAW_PLUGIN_STAGE_DIR" "$dep_path"
const fs = require("node:fs");
const path = require("node:path");

const stageDir = process.argv[2];
const depName = process.argv[3];
const manifestName = ".openclaw-runtime-deps.json";
const matches = [];

function visit(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (entry.name !== manifestName) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }
    const specs = Array.isArray(parsed.specs) ? parsed.specs : [];
    for (const spec of specs) {
      if (typeof spec === "string" && spec.startsWith(`${depName}@`)) {
        matches.push(`${fullPath}: ${spec}`);
      }
    }
  }
}

visit(stageDir);
if (matches.length > 0) {
  process.stderr.write(`${matches.join("\n")}\n`);
  process.exit(1);
}
NODE
  then
    echo "disabled $channel unexpectedly selected $dep_path for external runtime deps" >&2
    cat /tmp/openclaw-disabled-config-doctor.log >&2
    exit 1
  fi
}

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-disabled-config-install.log 2>&1

root="$(package_root)"
test -d "$root/dist/extensions/telegram"
test -d "$root/dist/extensions/discord"
test -d "$root/dist/extensions/slack"
rm -rf "$root/dist/extensions/telegram/node_modules"
rm -rf "$root/dist/extensions/discord/node_modules"
rm -rf "$root/dist/extensions/slack/node_modules"

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = {
  plugins: {
    enabled: true,
    entries: {
      discord: { enabled: false },
    },
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: "123456:disabled-config-token",
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
    slack: {
      enabled: false,
      botToken: "xoxb-disabled-config-token",
      appToken: "xapp-disabled-config-token",
    },
    discord: {
      enabled: true,
      token: "disabled-plugin-entry-token",
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
  },
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE

if ! openclaw doctor --non-interactive >/tmp/openclaw-disabled-config-doctor.log 2>&1; then
  echo "doctor failed for disabled-config runtime deps smoke" >&2
  cat /tmp/openclaw-disabled-config-doctor.log >&2
  exit 1
fi

assert_dep_absent_everywhere telegram grammy "$root"
assert_dep_absent_everywhere slack @slack/web-api "$root"
assert_dep_absent_everywhere discord discord-api-types "$root"

if grep -Eq "(used by .*\\b(telegram|slack|discord)\\b|\\[plugins\\] (telegram|slack|discord) installed bundled runtime deps( in [0-9]+ms)?:)" /tmp/openclaw-disabled-config-doctor.log; then
  echo "doctor installed runtime deps for an explicitly disabled channel/plugin" >&2
  cat /tmp/openclaw-disabled-config-doctor.log >&2
  exit 1
fi

echo "bundled channel disabled-config runtime deps Docker E2E passed"
EOF
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
