#!/usr/bin/env bash
#
# Runs baseline-to-current bundled plugin update scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_update_scenario() {
  local run_log
  run_log="$(docker_e2e_run_log bundled-channel-update)"

  echo "Running bundled channel runtime deps Docker update E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION="$UPDATE_BASELINE_VERSION" \
    -e "OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=${OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS:-telegram,discord,slack,feishu,memory-lancedb,acpx}" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-update.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-update-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_UPDATE_PACKAGE_SPEC=""

TOKEN="bundled-channel-update-token"
PORT="18790"
UPDATE_TARGETS="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS:-telegram,discord,slack,feishu,memory-lancedb,acpx}"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

stage_root() {
  printf "%s/.openclaw/plugin-runtime-deps" "$HOME"
}

poison_home_npm_project() {
  printf '{"name":"openclaw-home-prefix-poison","private":true}\n' >"$HOME/package.json"
  rm -rf "$HOME/node_modules"
  mkdir -p "$HOME/node_modules"
  chmod 500 "$HOME/node_modules"
}

find_external_dep_package() {
  local dep_path="$1"
  find "$(stage_root)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

assert_no_unknown_stage_roots() {
  if find "$(stage_root)" -maxdepth 1 -type d -name 'openclaw-unknown-*' -print -quit 2>/dev/null | grep -q .; then
    echo "runtime deps created second-generation unknown stage roots" >&2
    find "$(stage_root)" -maxdepth 1 -type d -name 'openclaw-*' -print | sort >&2 || true
    exit 1
  fi
}

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
update_target="file:$package_tgz"
candidate_version="$(node - <<'NODE' "$package_tgz"
const { execFileSync } = require("node:child_process");
const raw = execFileSync("tar", ["-xOf", process.argv[2], "package/package.json"], {
  encoding: "utf8",
});
process.stdout.write(String(JSON.parse(raw).version));
NODE
)"

write_config() {
  local mode="$1"
  node - <<'NODE' "$mode" "$TOKEN" "$PORT"
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const token = process.argv[3];
const port = Number(process.argv[4]);
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

config.gateway = {
  ...(config.gateway || {}),
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false },
};
config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: { primary: "openai/gpt-4.1-mini" },
  },
};
config.models = {
  ...(config.models || {}),
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...(config.models?.providers?.openai || {}),
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      models: [],
    },
  },
};
config.plugins = {
  ...(config.plugins || {}),
  enabled: true,
};
config.channels = {
  ...(config.channels || {}),
  telegram: {
    ...(config.channels?.telegram || {}),
    enabled: mode === "telegram",
    botToken: "123456:bundled-channel-update-token",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  discord: {
    ...(config.channels?.discord || {}),
    enabled: mode === "discord",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  slack: {
    ...(config.channels?.slack || {}),
    enabled: mode === "slack",
    botToken: "xoxb-bundled-channel-update-token",
    appToken: "xapp-bundled-channel-update-token",
  },
  feishu: {
    ...(config.channels?.feishu || {}),
    enabled: mode === "feishu",
  },
};
if (mode === "memory-lancedb") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow || []), "memory-lancedb"])],
    slots: {
      ...(config.plugins?.slots || {}),
      memory: "memory-lancedb",
    },
    entries: {
      ...(config.plugins?.entries || {}),
      "memory-lancedb": {
        ...(config.plugins?.entries?.["memory-lancedb"] || {}),
        enabled: true,
        config: {
          ...(config.plugins?.entries?.["memory-lancedb"]?.config || {}),
          embedding: {
            ...(config.plugins?.entries?.["memory-lancedb"]?.config?.embedding || {}),
            apiKey: process.env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
          },
          dbPath: "~/.openclaw/memory/lancedb-update-e2e",
          autoCapture: false,
          autoRecall: false,
        },
      },
    },
  };
}
if (mode === "acpx") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow:
      Array.isArray(config.plugins?.allow) && config.plugins.allow.length > 0
        ? [...new Set([...config.plugins.allow, "acpx"])]
        : config.plugins?.allow,
    entries: {
      ...(config.plugins?.entries || {}),
      acpx: {
        ...(config.plugins?.entries?.acpx || {}),
        enabled: true,
      },
    },
  };
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

assert_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  local root
  local sentinel
  root="$(package_root)"
  sentinel="$(find_external_dep_package "$dep_path")"
  if [ -z "$sentinel" ]; then
    echo "missing external dependency sentinel for $channel: $dep_path" >&2
    find "$(stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
    exit 1
  fi
  assert_no_package_dep_available "$channel" "$dep_path" "$root"
}

assert_no_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  assert_no_package_dep_available "$channel" "$dep_path" "$root"
  if [ -n "$(find_external_dep_package "$dep_path")" ]; then
    echo "external dependency sentinel should be absent before repair for $channel: $dep_path" >&2
    exit 1
  fi
}

assert_no_package_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root="$3"
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

assert_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root
  local sentinel
  root="$(package_root)"
  sentinel="$(find_external_dep_package "$dep_path")"
  if [ -n "$sentinel" ]; then
    assert_no_package_dep_available "$channel" "$dep_path" "$root"
    return 0
  fi
  echo "missing dependency sentinel for $channel: $dep_path" >&2
  find "$root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
  find "$root/node_modules" -maxdepth 3 -path "*/$dep_path/package.json" -type f -print >&2 || true
  find "$(stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
  exit 1
}

assert_no_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  assert_no_package_dep_available "$channel" "$dep_path" "$root"
  if [ -n "$(find_external_dep_package "$dep_path")" ]; then
    echo "dependency sentinel should be absent before repair for $channel: $dep_path" >&2
    exit 1
  fi
}

remove_runtime_dep() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  rm -rf "$root/dist/extensions/$channel/node_modules"
  rm -rf "$root/dist/extensions/node_modules/$dep_path"
  rm -rf "$root/node_modules/$dep_path"
  rm -rf "$(stage_root)"
}

assert_update_ok() {
  local json_file="$1"
  local expected_before="$2"
  node - <<'NODE' "$json_file" "$expected_before" "$candidate_version"
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedBefore = process.argv[3];
const expectedAfter = process.argv[4];
if (payload.status !== "ok") {
  throw new Error(`expected update status ok, got ${JSON.stringify(payload.status)}`);
}
if (expectedBefore && (payload.before?.version ?? null) !== expectedBefore) {
  throw new Error(
    `expected before.version ${expectedBefore}, got ${JSON.stringify(payload.before?.version)}`,
  );
}
if ((payload.after?.version ?? null) !== expectedAfter) {
  throw new Error(
    `expected after.version ${expectedAfter}, got ${JSON.stringify(payload.after?.version)}`,
  );
}
const steps = Array.isArray(payload.steps) ? payload.steps : [];
const doctor = steps.find((step) => step?.name === "openclaw doctor");
if (!doctor) {
  throw new Error("missing openclaw doctor step");
}
if (Number(doctor.exitCode ?? 1) !== 0) {
  throw new Error(`openclaw doctor step failed: ${JSON.stringify(doctor)}`);
}
NODE
}

run_update_and_capture() {
  local label="$1"
  local out_file="$2"
  set +e
  openclaw update --tag "$update_target" --yes --json >"$out_file" 2>"/tmp/openclaw-$label-update.stderr"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "openclaw update failed for $label with exit code $status" >&2
    cat "$out_file" >&2 || true
    cat "/tmp/openclaw-$label-update.stderr" >&2 || true
    exit "$status"
  fi
}

should_run_update_target() {
  local target="$1"
  case ",$UPDATE_TARGETS," in
    *",all,"* | *",$target,"*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Installing current candidate as update baseline..."
echo "Update targets: $UPDATE_TARGETS"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-update-baseline-install.log 2>&1
command -v openclaw >/dev/null
poison_home_npm_project
baseline_root="$(package_root)"
test -d "$baseline_root/dist/extensions/telegram"
test -d "$baseline_root/dist/extensions/feishu"
test -d "$baseline_root/dist/extensions/acpx"

if should_run_update_target telegram; then
  echo "Replicating configured Telegram missing-runtime state..."
  write_config telegram
  assert_no_dep_available telegram grammy
  set +e
  openclaw doctor --non-interactive >/tmp/openclaw-baseline-doctor.log 2>&1
  baseline_doctor_status=$?
  set -e
  echo "baseline doctor exited with $baseline_doctor_status"
  remove_runtime_dep telegram grammy
  assert_no_dep_available telegram grammy

  echo "Updating from baseline to current candidate; candidate doctor must repair Telegram deps..."
  run_update_and_capture telegram /tmp/openclaw-update-telegram.json
  cat /tmp/openclaw-update-telegram.json
  assert_update_ok /tmp/openclaw-update-telegram.json "$candidate_version"
  assert_dep_available telegram grammy
  assert_no_unknown_stage_roots

  echo "Mutating installed package: remove Telegram deps, then update-mode doctor repairs them..."
  remove_runtime_dep telegram grammy
  assert_no_dep_available telegram grammy
  if ! OPENCLAW_UPDATE_IN_PROGRESS=1 openclaw doctor --non-interactive >/tmp/openclaw-update-mode-doctor.log 2>&1; then
    echo "update-mode doctor failed while repairing Telegram deps" >&2
    cat /tmp/openclaw-update-mode-doctor.log >&2
    exit 1
  fi
  assert_dep_available telegram grammy
  assert_no_unknown_stage_roots
fi

if should_run_update_target discord; then
  echo "Mutating config to Discord and rerunning same-version update path..."
  write_config discord
  remove_runtime_dep discord discord-api-types
  assert_no_dep_available discord discord-api-types
  run_update_and_capture discord /tmp/openclaw-update-discord.json
  cat /tmp/openclaw-update-discord.json
  assert_update_ok /tmp/openclaw-update-discord.json "$candidate_version"
  assert_dep_available discord discord-api-types
fi

if should_run_update_target slack; then
  echo "Mutating config to Slack and rerunning same-version update path..."
  write_config slack
  remove_runtime_dep slack @slack/web-api
  assert_no_dep_available slack @slack/web-api
  run_update_and_capture slack /tmp/openclaw-update-slack.json
  cat /tmp/openclaw-update-slack.json
  assert_update_ok /tmp/openclaw-update-slack.json "$candidate_version"
  assert_dep_available slack @slack/web-api
fi

if should_run_update_target feishu; then
  echo "Mutating config to Feishu and rerunning same-version update path..."
  write_config feishu
  remove_runtime_dep feishu @larksuiteoapi/node-sdk
  assert_no_dep_available feishu @larksuiteoapi/node-sdk
  run_update_and_capture feishu /tmp/openclaw-update-feishu.json
  cat /tmp/openclaw-update-feishu.json
  assert_update_ok /tmp/openclaw-update-feishu.json "$candidate_version"
  assert_dep_available feishu @larksuiteoapi/node-sdk
fi

if should_run_update_target memory-lancedb; then
  echo "Mutating config to memory-lancedb and rerunning same-version update path..."
  write_config memory-lancedb
  remove_runtime_dep memory-lancedb @lancedb/lancedb
  assert_no_dep_available memory-lancedb @lancedb/lancedb
  run_update_and_capture memory-lancedb /tmp/openclaw-update-memory-lancedb.json
  cat /tmp/openclaw-update-memory-lancedb.json
  assert_update_ok /tmp/openclaw-update-memory-lancedb.json "$candidate_version"
  assert_dep_available memory-lancedb @lancedb/lancedb
fi

if should_run_update_target acpx; then
  echo "Removing ACPX runtime package and rerunning same-version update path..."
  write_config acpx
  remove_runtime_dep acpx acpx
  assert_no_dep_available acpx acpx
  run_update_and_capture acpx /tmp/openclaw-update-acpx.json
  cat /tmp/openclaw-update-acpx.json
  assert_update_ok /tmp/openclaw-update-acpx.json "$candidate_version"
  assert_dep_available acpx acpx
fi

echo "bundled channel runtime deps Docker update E2E passed"
EOF
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
