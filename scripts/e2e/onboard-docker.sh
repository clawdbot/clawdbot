#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="clawdbot-onboard-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running onboarding E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail
  trap "" PIPE
  export TERM=xterm-256color

  # Provide a minimal trash shim to avoid noisy "missing trash" logs in containers.
  export PATH="/tmp/clawdbot-bin:$PATH"
  mkdir -p /tmp/clawdbot-bin
  cat > /tmp/clawdbot-bin/trash <<'"'"'TRASH'"'"'
#!/usr/bin/env bash
set -euo pipefail
trash_dir="$HOME/.Trash"
mkdir -p "$trash_dir"
for target in "$@"; do
  [ -e "$target" ] || continue
  base="$(basename "$target")"
  dest="$trash_dir/$base"
  if [ -e "$dest" ]; then
    dest="$trash_dir/${base}-$(date +%s)-$$"
  fi
  mv "$target" "$dest"
done
TRASH
  chmod +x /tmp/clawdbot-bin/trash

  send() {
    local payload="$1"
    local delay="${2:-0.4}"
    # Let prompts render before sending keystrokes.
    sleep "$delay"
    printf "%b" "$payload" >&3 2>/dev/null || true
  }

  start_gateway() {
    node dist/index.js gateway-daemon --port 18789 --bind loopback > /tmp/gateway-e2e.log 2>&1 &
    GATEWAY_PID="$!"
  }

  wait_for_gateway() {
    for _ in $(seq 1 10); do
      if grep -q "listening on ws://127.0.0.1:18789" /tmp/gateway-e2e.log; then
        return 0
      fi
      sleep 1
    done
    cat /tmp/gateway-e2e.log
    return 1
  }

  stop_gateway() {
    local gw_pid="$1"
    if [ -n "$gw_pid" ]; then
      kill "$gw_pid" 2>/dev/null || true
      wait "$gw_pid" || true
    fi
  }

  run_wizard_cmd() {
    local case_name="$1"
    local home_dir="$2"
    local command="$3"
    local send_fn="$4"
    local with_gateway="${5:-false}"

    echo "== Wizard case: $case_name =="
    export HOME="$home_dir"
    mkdir -p "$HOME"

    input_fifo="$(mktemp -u "/tmp/clawdbot-onboard-${case_name}.XXXXXX")"
    mkfifo "$input_fifo"
    # Run under script to keep an interactive TTY for clack prompts.
    script -q -c "$command" /dev/null < "$input_fifo" &
    wizard_pid=$!
    exec 3> "$input_fifo"

    local gw_pid=""
    if [ "$with_gateway" = "true" ]; then
      start_gateway
      gw_pid="$GATEWAY_PID"
      wait_for_gateway
    fi

    "$send_fn"

    exec 3>&-
    wait "$wizard_pid"
    rm -f "$input_fifo"
    stop_gateway "$gw_pid"
  }

  run_wizard() {
    local case_name="$1"
    local home_dir="$2"
    local send_fn="$3"

    # Default onboarding command wrapper.
    run_wizard_cmd "$case_name" "$home_dir" "node dist/index.js onboard" "$send_fn" true
  }

  make_home() {
    mktemp -d "/tmp/clawdbot-e2e-$1.XXXXXX"
  }

  assert_file() {
    local file_path="$1"
    if [ ! -f "$file_path" ]; then
      echo "Missing file: $file_path"
      exit 1
    fi
  }

  assert_dir() {
    local dir_path="$1"
    if [ ! -d "$dir_path" ]; then
      echo "Missing dir: $dir_path"
      exit 1
    fi
  }

  send_local_basic() {
    # Choose local gateway, accept defaults, skip provider/skills/daemon, skip UI.
    send $'"'"'\r'"'"' 1.0
    send $'"'"'\r'"'"' 1.0
    send "" 1.2
    send $'"'"'\e[B'"'"' 0.6
    send $'"'"'\e[B'"'"' 0.6
    send $'"'"'\e[B'"'"' 0.6
    send $'"'"'\e[B'"'"' 0.6
    send $'"'"'\e[B'"'"' 0.6
    send $'"'"'\r'"'"' 0.6
    send $'"'"'\r'"'"' 0.5
    send $'"'"'\r'"'"' 0.5
    send $'"'"'\r'"'"' 0.5
    send $'"'"'\r'"'"' 0.5
    send $'"'"'n\r'"'"' 0.5
    send $'"'"'n\r'"'"' 0.5
    send $'"'"'n\r'"'"' 0.5
    send $'"'"'n\r'"'"' 0.5
  }

  send_reset_config_only() {
    # Reset config + reuse the local defaults flow.
    send $'"'"'\e[B'"'"' 0.3
    send $'"'"'\e[B'"'"' 0.3
    send $'"'"'\r'"'"' 0.4
    send $'"'"'\r'"'"' 0.4
    send "" 1.2
    send_local_basic
  }

  send_providers_flow() {
    # Configure providers via configure wizard.
    send "" 0.6
    send $'"'"'\r'"'"' 0.8
    send "" 1.2
    # Select Providers section only.
    send $'"'"'\e[B'"'"' 0.5
    send $'"'"'\e[B'"'"' 0.5
    send $'"'"'\e[B'"'"' 0.5
    send $'"'"'\e[B'"'"' 0.5
    send $'"'"' '"'"' 0.4
    send $'"'"'\r'"'"' 0.6
    # Configure providers now? (default Yes)
    send $'"'"'\r'"'"' 0.8
    send "" 0.8
    # Select Telegram, Discord, Slack.
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"' '"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"' '"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"' '"'"' 0.4
    send $'"'"'\r'"'"' 0.6
    send $'"'"'tg_token\r'"'"' 0.8
    send $'"'"'discord_token\r'"'"' 0.8
    send "" 0.6
    send $'"'"'\r'"'"' 0.6
    send "" 0.6
    send $'"'"'slack_bot\r'"'"' 0.8
    send "" 0.6
    send $'"'"'slack_app\r'"'"' 0.8
  }

  send_skills_flow() {
    # Select skills section and skip optional installs.
    send "" 0.6
    send $'"'"'\r'"'"' 0.6
    send "" 1.0
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"'\e[B'"'"' 0.4
    send $'"'"' '"'"' 0.3
    send $'"'"'\r'"'"' 0.4
    send $'"'"'n\r'"'"' 0.4
    send $'"'"'n\r'"'"' 0.4
  }

  run_case_local_basic() {
    local home_dir
    home_dir="$(make_home local-basic)"
    run_wizard local-basic "$home_dir" send_local_basic

    # Assert config + workspace scaffolding.
    workspace_dir="$HOME/clawd"
    config_path="$HOME/.clawdbot/clawdbot.json"
    sessions_dir="$HOME/.clawdbot/sessions"

    assert_file "$config_path"
    assert_dir "$sessions_dir"
    for file in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
      assert_file "$workspace_dir/$file"
    done

    CONFIG_PATH="$config_path" WORKSPACE_DIR="$workspace_dir" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const expectedWorkspace = process.env.WORKSPACE_DIR;
const errors = [];

if (cfg?.agent?.workspace !== expectedWorkspace) {
  errors.push(`agent.workspace mismatch (got ${cfg?.agent?.workspace ?? "unset"})`);
}
if (cfg?.gateway?.mode !== "local") {
  errors.push(`gateway.mode mismatch (got ${cfg?.gateway?.mode ?? "unset"})`);
}
if (cfg?.gateway?.bind !== "loopback") {
  errors.push(`gateway.bind mismatch (got ${cfg?.gateway?.bind ?? "unset"})`);
}
if ((cfg?.gateway?.tailscale?.mode ?? "off") !== "off") {
  errors.push(
    `gateway.tailscale.mode mismatch (got ${cfg?.gateway?.tailscale?.mode ?? "unset"})`,
  );
}
if (!cfg?.wizard?.lastRunAt) {
  errors.push("wizard.lastRunAt missing");
}
if (!cfg?.wizard?.lastRunVersion) {
  errors.push("wizard.lastRunVersion missing");
}
if (cfg?.wizard?.lastRunCommand !== "onboard") {
  errors.push(
    `wizard.lastRunCommand mismatch (got ${cfg?.wizard?.lastRunCommand ?? "unset"})`,
  );
}
if (cfg?.wizard?.lastRunMode !== "local") {
  errors.push(
    `wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`,
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE

    node dist/index.js gateway-daemon --port 18789 --bind loopback > /tmp/gateway.log 2>&1 &
    GW_PID=$!
    # Gate on gateway readiness, then run health.
    for _ in $(seq 1 10); do
      if grep -q "listening on ws://127.0.0.1:18789" /tmp/gateway.log; then
        break
      fi
      sleep 1
    done

    if ! grep -q "listening on ws://127.0.0.1:18789" /tmp/gateway.log; then
      cat /tmp/gateway.log
      exit 1
    fi

    node dist/index.js health --timeout 2000 || (cat /tmp/gateway.log && exit 1)

    kill "$GW_PID"
    wait "$GW_PID" || true
  }

  run_case_remote_non_interactive() {
    local home_dir
    home_dir="$(make_home remote-non-interactive)"
    export HOME="$home_dir"
    mkdir -p "$HOME"
    # Smoke test non-interactive remote config write.
    node dist/index.js onboard --non-interactive \
      --mode remote \
      --remote-url ws://gateway.local:18789 \
      --remote-token remote-token \
      --skip-skills \
      --skip-health

    config_path="$HOME/.clawdbot/clawdbot.json"
    assert_file "$config_path"

    CONFIG_PATH="$config_path" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const errors = [];

if (cfg?.gateway?.mode !== "remote") {
  errors.push(`gateway.mode mismatch (got ${cfg?.gateway?.mode ?? "unset"})`);
}
if (cfg?.gateway?.remote?.url !== "ws://gateway.local:18789") {
  errors.push(`gateway.remote.url mismatch (got ${cfg?.gateway?.remote?.url ?? "unset"})`);
}
if (cfg?.gateway?.remote?.token !== "remote-token") {
  errors.push(`gateway.remote.token mismatch (got ${cfg?.gateway?.remote?.token ?? "unset"})`);
}
if (cfg?.wizard?.lastRunMode !== "remote") {
  errors.push(`wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
  }

  run_case_reset() {
    local home_dir
    home_dir="$(make_home reset-config)"
    export HOME="$home_dir"
    mkdir -p "$HOME/.clawdbot"
    # Seed a remote config to exercise reset path.
    cat > "$HOME/.clawdbot/clawdbot.json" <<'"'"'JSON'"'"'
{
  "agent": { "workspace": "/root/old" },
  "gateway": {
    "mode": "remote",
    "remote": { "url": "ws://old.example:18789", "token": "old-token" }
  }
}
JSON

    run_wizard reset-config "$home_dir" send_reset_config_only

    config_path="$HOME/.clawdbot/clawdbot.json"
    assert_file "$config_path"

    CONFIG_PATH="$config_path" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const errors = [];

if (cfg?.gateway?.mode !== "local") {
  errors.push(`gateway.mode mismatch (got ${cfg?.gateway?.mode ?? "unset"})`);
}
if (cfg?.gateway?.remote?.url) {
  errors.push(`gateway.remote.url should be cleared (got ${cfg?.gateway?.remote?.url})`);
}
if (cfg?.wizard?.lastRunMode !== "local") {
  errors.push(`wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
  }

  run_case_providers() {
    local home_dir
    home_dir="$(make_home providers)"
    # Providers-only configure flow.
    run_wizard_cmd providers "$home_dir" "node dist/index.js configure" send_providers_flow

    config_path="$HOME/.clawdbot/clawdbot.json"
    assert_file "$config_path"

    CONFIG_PATH="$config_path" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const errors = [];

if (cfg?.telegram?.botToken !== "tg_token") {
  errors.push(`telegram.botToken mismatch (got ${cfg?.telegram?.botToken ?? "unset"})`);
}
if (cfg?.discord?.token !== "discord_token") {
  errors.push(`discord.token mismatch (got ${cfg?.discord?.token ?? "unset"})`);
}
if (cfg?.slack?.botToken !== "slack_bot") {
  errors.push(`slack.botToken mismatch (got ${cfg?.slack?.botToken ?? "unset"})`);
}
if (cfg?.slack?.appToken !== "slack_app") {
  errors.push(`slack.appToken mismatch (got ${cfg?.slack?.appToken ?? "unset"})`);
}
if (cfg?.wizard?.lastRunMode !== "local") {
  errors.push(`wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
  }

  run_case_skills() {
    local home_dir
    home_dir="$(make_home skills)"
    export HOME="$home_dir"
    mkdir -p "$HOME/.clawdbot"
    # Seed skills config to ensure it survives the wizard.
    cat > "$HOME/.clawdbot/clawdbot.json" <<'"'"'JSON'"'"'
{
  "skills": {
    "allowBundled": ["__none__"],
    "install": { "nodeManager": "bun" }
  }
}
JSON

    run_wizard_cmd skills "$home_dir" "node dist/index.js configure" send_skills_flow

    config_path="$HOME/.clawdbot/clawdbot.json"
    assert_file "$config_path"

    CONFIG_PATH="$config_path" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const errors = [];

if (cfg?.skills?.install?.nodeManager !== "bun") {
  errors.push(`skills.install.nodeManager mismatch (got ${cfg?.skills?.install?.nodeManager ?? "unset"})`);
}
if (!Array.isArray(cfg?.skills?.allowBundled) || cfg.skills.allowBundled[0] !== "__none__") {
  errors.push("skills.allowBundled missing");
}
if (cfg?.wizard?.lastRunMode !== "local") {
  errors.push(`wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
  }

  run_case_local_basic
  run_case_remote_non_interactive
  run_case_reset
  run_case_providers
  run_case_skills
'

echo "E2E complete."
