#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-onboard-e2e" OPENCLAW_ONBOARD_E2E_IMAGE)"

docker_e2e_build_or_reuse "$IMAGE_NAME" onboard

echo "Running onboarding E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail
	  trap "" PIPE
	  export TERM=xterm-256color
	  ONBOARD_FLAGS="--flow quickstart --auth-choice skip --skip-channels --skip-skills --skip-daemon --skip-ui"
	  # tsdown may emit dist/index.js or dist/index.mjs depending on runtime/bundler.
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

  # Provide a minimal trash shim to avoid noisy "missing trash" logs in containers.
  export PATH="/tmp/openclaw-bin:$PATH"
  mkdir -p /tmp/openclaw-bin
  cat > /tmp/openclaw-bin/trash <<'"'"'TRASH'"'"'
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
  chmod +x /tmp/openclaw-bin/trash

  send() {
    local payload="$1"
    local delay="${2:-0.4}"
    # Let prompts render before sending keystrokes.
    sleep "$delay"
    printf "%b" "$payload" >&3 2>/dev/null || true
  }

  wait_for_log() {
    local needle="$1"
    local timeout_s="${2:-45}"
    local quiet_on_timeout="${3:-false}"
    local needle_compact
    needle_compact="$(printf "%s" "$needle" | tr -cd "[:alpha:]")"
    local start_s
    start_s="$(date +%s)"
    while true; do
      if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
        if grep -a -F -q "$needle" "$WIZARD_LOG_PATH"; then
          return 0
        fi
        if NEEDLE=\"$needle_compact\" node --input-type=module -e "
          import fs from \"node:fs\";
          const file = process.env.WIZARD_LOG_PATH;
          const needle = process.env.NEEDLE ?? \"\";
          let text = \"\";
          try { text = fs.readFileSync(file, \"utf8\"); } catch { process.exit(1); }
          // Clack/script output can include lots of control sequences; keep a larger tail and strip ANSI more robustly.
          if (text.length > 120000) text = text.slice(-120000);
          const normalizeScriptOutput = (value) =>
            value
              // util-linux script can emit each byte on its own CRLF-delimited line.
              // Collapse those first so ANSI/control stripping works on real sequences.
              .replace(/\\r?\\n/g, \"\")
              .replace(/\\r/g, \"\");
          const stripAnsi = (value) =>
            normalizeScriptOutput(value)
              // OSC: ESC ] ... BEL or ESC \\
              .replace(/\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)/g, \"\")
              // CSI: ESC [ ... cmd
              .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, \"\");
          // Letters-only: script output sometimes fragments ANSI sequences into digits/letters that
          // can otherwise break substring matching.
          const compact = (value) => stripAnsi(value).toLowerCase().replace(/[^a-z]+/g, \"\");
          const haystack = compact(text);
          const compactNeedle = compact(needle);
          if (!compactNeedle) process.exit(1);
          process.exit(haystack.includes(compactNeedle) ? 0 : 1);
        "; then
          return 0
        fi
      fi
      if [ $(( $(date +%s) - start_s )) -ge "$timeout_s" ]; then
        if [ "$quiet_on_timeout" = "true" ]; then
          return 1
        fi
        echo "Timeout waiting for log: $needle"
        if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
          tail -n 140 "$WIZARD_LOG_PATH" || true
        fi
        return 1
      fi
      sleep 0.2
    done
  }

	  start_gateway() {
	    node "$OPENCLAW_ENTRY" gateway --port 18789 --bind loopback --allow-unconfigured > /tmp/gateway-e2e.log 2>&1 &
	    GATEWAY_PID="$!"
	  }

  wait_for_gateway() {
    for _ in $(seq 1 20); do
      if node --input-type=module -e "
        import net from 'node:net';
        const socket = net.createConnection({ host: '127.0.0.1', port: 18789 });
        const timeout = setTimeout(() => {
          socket.destroy();
          process.exit(1);
        }, 500);
        socket.on('connect', () => {
          clearTimeout(timeout);
          socket.end();
          process.exit(0);
        });
        socket.on('error', () => {
          clearTimeout(timeout);
          process.exit(1);
        });
      " >/dev/null 2>&1; then
        return 0
      fi
      if [ -f /tmp/gateway-e2e.log ] && grep -E -q "listening on ws://[^ ]+:18789" /tmp/gateway-e2e.log; then
        if [ -n "${GATEWAY_PID:-}" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
          return 0
        fi
      fi
      sleep 1
    done
    echo "Gateway failed to start"
    cat /tmp/gateway-e2e.log || true
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
    local validate_fn="${6:-}"

    echo "== Wizard case: $case_name =="
    set_isolated_openclaw_env "$home_dir"

    input_fifo="$(mktemp -u "/tmp/openclaw-onboard-${case_name}.XXXXXX")"
    mkfifo "$input_fifo"
    local log_path="/tmp/openclaw-onboard-${case_name}.log"
    WIZARD_LOG_PATH="$log_path"
    export WIZARD_LOG_PATH
    # Run under script to keep an interactive TTY for clack prompts.
    script -q -f -c "$command" "$log_path" < "$input_fifo" >/dev/null 2>&1 &
    wizard_pid=$!
    exec 3> "$input_fifo"

    local gw_pid=""
    if [ "$with_gateway" = "true" ]; then
      start_gateway
      gw_pid="$GATEWAY_PID"
      wait_for_gateway
    fi

    "$send_fn"

    if ! wait "$wizard_pid"; then
      wizard_status=$?
      exec 3>&-
      rm -f "$input_fifo"
      stop_gateway "$gw_pid"
      echo "Wizard exited with status $wizard_status"
      if [ -f "$log_path" ]; then
        tail -n 160 "$log_path" || true
      fi
      exit "$wizard_status"
    fi
    exec 3>&-
    rm -f "$input_fifo"
    stop_gateway "$gw_pid"
    if [ -n "$validate_fn" ]; then
      "$validate_fn" "$log_path"
    fi
  }

  run_wizard() {
    local case_name="$1"
    local home_dir="$2"
    local send_fn="$3"
    local validate_fn="${4:-}"

	    # Default onboarding command wrapper.
	    run_wizard_cmd "$case_name" "$home_dir" "node \"$OPENCLAW_ENTRY\" onboard $ONBOARD_FLAGS" "$send_fn" true "$validate_fn"
	  }

  make_home() {
    mktemp -d "/tmp/openclaw-e2e-$1.XXXXXX"
  }

  set_isolated_openclaw_env() {
    local home_dir="$1"
    export HOME="$home_dir"
    export OPENCLAW_HOME="$home_dir"
    export OPENCLAW_STATE_DIR="$home_dir/.openclaw"
    export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
    mkdir -p "$OPENCLAW_STATE_DIR"
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

  run_case_logged() {
    local label="$1"
    shift
    local log_path="/tmp/openclaw-onboard-${label}.log"
    if ! "$@" >"$log_path" 2>&1; then
      cat "$log_path"
      exit 1
    fi
  }

  select_skip_hooks() {
    # Hooks multiselect: pick "Skip for now".
    wait_for_log "Enable hooks?" 60
    send $'"'"' \r'"'"' 0.6
  }

  send_local_basic() {
    # Risk acknowledgement (default is "No").
    wait_for_log "Continue?" 60
    send $'"'"'y\r'"'"' 0.6
    # Non-interactive flow; no gateway-location prompt.
    select_skip_hooks
  }

  send_reset_config_only() {
    # Risk acknowledgement (default is "No").
    wait_for_log "Continue?" 40
    send $'"'"'y\r'"'"' 0.8
    # Select reset flow for existing config.
    wait_for_log "Config handling" 40
    send $'"'"'\e[B'"'"' 0.3
    send $'"'"'\e[B'"'"' 0.3
    send $'"'"'\r'"'"' 0.4
    # Reset scope -> Config only (default).
    wait_for_log "Reset scope" 40
    send $'"'"'\r'"'"' 0.4
    select_skip_hooks
  }

  send_channels_flow() {
    # Configure channels via configure wizard. Use the remove-config branch for
    # a stable no-op smoke path when the config starts empty.
    wait_for_log "Where will the Gateway run?" 120
    send $'"'"'\r'"'"' 0.6
    wait_for_log "Configure/link" 120
    send $'"'"'\e[B\r'"'"' 0.8
    # Keep stdin open until wizard exits.
    send "" 2.0
  }

  send_skills_flow() {
    # configure --section skills still runs the configure wizard.
    wait_for_log "Where will the Gateway run?" 120
    send $'"'"'\r'"'"' 0.6
    wait_for_log "Configure skills now?" 120
    send $'"'"'n\r'"'"' 0.8
    send "" 2.0
  }

  run_case_local_basic() {
    local home_dir
    home_dir="$(make_home local-basic)"
    set_isolated_openclaw_env "$home_dir"
    run_case_logged local-basic node "$OPENCLAW_ENTRY" onboard \
	      --non-interactive \
	      --accept-risk \
      --flow quickstart \
      --mode local \
      --skip-channels \
      --skip-skills \
      --skip-daemon \
      --skip-ui \
      --skip-health

    # Assert config + workspace scaffolding.
    workspace_dir="$OPENCLAW_STATE_DIR/workspace"
    config_path="$OPENCLAW_CONFIG_PATH"
    sessions_dir="$OPENCLAW_STATE_DIR/agents/main/sessions"

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

if (cfg?.agents?.defaults?.workspace !== expectedWorkspace) {
  errors.push(
    `agents.defaults.workspace mismatch (got ${cfg?.agents?.defaults?.workspace ?? "unset"})`,
  );
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

  }

  run_case_remote_non_interactive() {
    local home_dir
    home_dir="$(make_home remote-non-interactive)"
    set_isolated_openclaw_env "$home_dir"
	    # Smoke test non-interactive remote config write.
	    run_case_logged remote-non-interactive node "$OPENCLAW_ENTRY" onboard --non-interactive --accept-risk \
	      --mode remote \
	      --remote-url ws://gateway.local:18789 \
      --remote-token remote-token \
      --skip-skills \
      --skip-health

    config_path="$OPENCLAW_CONFIG_PATH"
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
    set_isolated_openclaw_env "$home_dir"
    # Seed a remote config to exercise reset path.
	    cat > "$OPENCLAW_CONFIG_PATH" <<'"'"'JSON'"'"'
{
  "meta": {},
  "agents": { "defaults": { "workspace": "/root/old" } },
  "gateway": {
    "mode": "remote",
    "remote": { "url": "ws://old.example:18789", "token": "old-token" }
  }
}
JSON

	    run_case_logged reset-config node "$OPENCLAW_ENTRY" onboard \
	      --non-interactive \
	      --accept-risk \
      --flow quickstart \
      --mode local \
      --reset \
      --skip-channels \
      --skip-skills \
      --skip-daemon \
      --skip-ui \
      --skip-health

    config_path="$OPENCLAW_CONFIG_PATH"
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

  run_case_channels() {
	    local home_dir
	    home_dir="$(make_home channels)"
	    # Channels-only configure flow.
	    run_wizard_cmd channels "$home_dir" "node \"$OPENCLAW_ENTRY\" configure --section channels" send_channels_flow

    config_path="$OPENCLAW_CONFIG_PATH"
    assert_file "$config_path"

    CONFIG_PATH="$config_path" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const errors = [];

    if (cfg?.telegram?.botToken) {
      errors.push(`telegram.botToken should be unset (got ${cfg?.telegram?.botToken})`);
    }
    if (cfg?.discord?.token) {
      errors.push(`discord.token should be unset (got ${cfg?.discord?.token})`);
    }
    if (cfg?.slack?.botToken || cfg?.slack?.appToken) {
      errors.push(
        `slack tokens should be unset (got bot=${cfg?.slack?.botToken ?? "unset"}, app=${cfg?.slack?.appToken ?? "unset"})`,
      );
    }
    if (cfg?.wizard?.lastRunCommand !== "configure") {
      errors.push(
        `wizard.lastRunCommand mismatch (got ${cfg?.wizard?.lastRunCommand ?? "unset"})`,
      );
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
    set_isolated_openclaw_env "$home_dir"
    # Seed skills config to ensure it survives the wizard.
	    cat > "$OPENCLAW_CONFIG_PATH" <<'"'"'JSON'"'"'
{
  "meta": {},
  "skills": {
    "allowBundled": ["__none__"],
    "install": { "nodeManager": "bun" }
  }
}
JSON

	    run_wizard_cmd skills "$home_dir" "node \"$OPENCLAW_ENTRY\" configure --section skills" send_skills_flow

    config_path="$OPENCLAW_CONFIG_PATH"
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

  assert_log_not_contains() {
    local file_path="$1"
    local needle="$2"
    if grep -q "$needle" "$file_path"; then
      echo "Unexpected log output: $needle"
      exit 1
    fi
  }

  validate_local_basic_log() {
    local log_path="$1"
    assert_log_not_contains "$log_path" "systemctl --user unavailable"
  }

  run_case_local_basic
  run_case_remote_non_interactive
  run_case_reset
  run_case_channels
  run_case_skills
'

echo "E2E complete."
