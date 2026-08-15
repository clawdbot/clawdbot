#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/computer-use-macos-live-rig.sh prepare <profile> <port> <app> <scratch> [peekaboo|cua]
  scripts/dev/computer-use-macos-live-rig.sh gateway <scratch>
  scripts/dev/computer-use-macos-live-rig.sh app <scratch> [peekaboo|cua]
  scripts/dev/computer-use-macos-live-rig.sh nodes <scratch>
  scripts/dev/computer-use-macos-live-rig.sh proof <scratch> <peekaboo|cua> <window-title> <text> [element-label]

The rig is maintainer-only and loopback-only. Run gateway and app in separate
terminals, approve the dedicated CLI device after its first `nodes` request,
then run `proof`. Never use the operator profile or port 18789.
EOF
}

fail() {
  echo "computer-use live rig: $*" >&2
  exit 1
}

validate_provider() {
  case "$1" in
    peekaboo | cua) ;;
    *) fail "provider must be peekaboo or cua" ;;
  esac
}

require_unoccupied_port() {
  local port="$1"
  if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    fail "port $port already has a listener; choose a fresh proof port"
  fi
}

load_rig() {
  local scratch="$1"
  [[ "$scratch" = /* ]] || fail "scratch path must be absolute"
  local rig_path="$scratch/rig.json"
  [[ -f "$rig_path" ]] || fail "missing $rig_path; run prepare first"
  local rig_values=()
  while IFS= read -r -d '' value; do
    rig_values+=("$value")
  done < <(node - "$rig_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const keys = ["root", "profile", "port", "app", "appState", "gatewayConfig", "agentState"];
try {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.join("\0") !== [...keys].sort().join("\0")) throw new Error("unexpected fields");
  if (!Number.isInteger(value.port)) throw new Error("port must be an integer");
  const fields = [value.root, value.profile, String(value.port), value.app, value.appState, value.gatewayConfig, value.agentState];
  if (fields.some((field) => typeof field !== "string" || field.includes("\0"))) throw new Error("invalid field");
  process.stdout.write(`${fields.join("\0")}\0`);
} catch (error) {
  console.error(`invalid rig state: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
NODE
  )
  [[ ${#rig_values[@]} -eq 7 ]] || fail "invalid $rig_path"
  OPENCLAW_CU_RIG_ROOT="${rig_values[0]}"
  OPENCLAW_CU_RIG_PROFILE="${rig_values[1]}"
  OPENCLAW_CU_RIG_PORT="${rig_values[2]}"
  OPENCLAW_CU_RIG_APP="${rig_values[3]}"
  OPENCLAW_CU_RIG_APP_STATE="${rig_values[4]}"
  OPENCLAW_CU_RIG_GATEWAY_CONFIG="${rig_values[5]}"
  OPENCLAW_CU_RIG_AGENT_STATE="${rig_values[6]}"
  [[ "$OPENCLAW_CU_RIG_ROOT" == "$repo_root" ]] ||
    fail "rig belongs to a different checkout: $OPENCLAW_CU_RIG_ROOT"
  [[ "$OPENCLAW_CU_RIG_PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]+$ ]] || fail "invalid rig profile"
  [[ "$OPENCLAW_CU_RIG_PORT" =~ ^[0-9]+$ ]] || fail "invalid rig port"
  ((OPENCLAW_CU_RIG_PORT >= 1024 && OPENCLAW_CU_RIG_PORT <= 65535)) || fail "invalid rig port"
  ((OPENCLAW_CU_RIG_PORT != 18789)) || fail "operator port is not valid rig state"
  [[ "$OPENCLAW_CU_RIG_APP" = /* ]] || fail "invalid rig app path"
  [[ "$OPENCLAW_CU_RIG_APP_STATE" == "$HOME/.openclaw-$OPENCLAW_CU_RIG_PROFILE" ]] ||
    fail "rig app state does not match its profile"
  [[ "$OPENCLAW_CU_RIG_GATEWAY_CONFIG" == "$scratch/gateway.json" ]] ||
    fail "rig gateway config is outside its scratch directory"
  [[ "$OPENCLAW_CU_RIG_AGENT_STATE" == "$scratch/agent-state" ]] ||
    fail "rig agent state is outside its scratch directory"
}

prepare() {
  [[ $# -ge 4 && $# -le 5 ]] || { usage; exit 2; }
  local profile="$1"
  local port="$2"
  local app_input="$3"
  local scratch="$4"
  local provider="${5:-peekaboo}"

  [[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9_-]+$ ]] ||
    fail "profile must contain only letters, digits, underscores, and dashes"
  case "$profile" in
    default | main | local) fail "choose a fresh, explicitly isolated profile" ;;
  esac
  [[ "$port" =~ ^[0-9]+$ ]] || fail "port must be numeric"
  ((port >= 1024 && port <= 65535)) || fail "port must be between 1024 and 65535"
  ((port != 18789)) || fail "port 18789 belongs to the operator gateway"
  [[ "$scratch" = /* ]] || fail "scratch path must be absolute"
  validate_provider "$provider"
  require_unoccupied_port "$port"

  local app_path
  app_path="$(cd "$(dirname "$app_input")" && pwd)/$(basename "$app_input")"
  local app_executable="$app_path/Contents/MacOS/OpenClaw"
  [[ -x "$app_executable" ]] || fail "signed app executable not found: $app_executable"
  codesign --verify --deep --strict "$app_path" >/dev/null 2>&1 ||
    fail "app is not a valid signed bundle: $app_path"

  git -C "$repo_root" diff --quiet -- src packages extensions scripts/run-node.mjs scripts/run-node.mts ||
    fail "runtime sources are dirty; commit and rebuild before launching the node worker"
  git -C "$repo_root" diff --cached --quiet -- src packages extensions scripts/run-node.mjs scripts/run-node.mts ||
    fail "runtime sources are staged but uncommitted; commit and rebuild first"

  local app_state="$HOME/.openclaw-$profile"
  local defaults_domain="ai.openclaw.mac.profile.$profile"
  [[ ! -e "$app_state" && ! -L "$app_state" ]] ||
    fail "$app_state already exists; choose a fresh proof profile"
  if defaults read "$defaults_domain" >/dev/null 2>&1; then
    fail "$defaults_domain already has saved settings; choose a fresh proof profile"
  fi
  [[ ! -e "$scratch/rig.json" ]] || fail "$scratch already contains a rig"
  mkdir -p "$scratch" "$scratch/agent-state"

  local app_config="$app_state/openclaw.json"
  local staged_app_config="$scratch/app.json"
  local gateway_config="$scratch/gateway.json"

  node - "$port" >"$gateway_config" <<'NODE'
const port = Number(process.argv[2]);
process.stdout.write(`${JSON.stringify({
  gateway: {
    mode: "local",
    port,
    auth: { mode: "none" },
    nodes: { commands: { allow: ["computer.act"] } },
  },
}, null, 2)}\n`);
NODE

  node - "$port" >"$staged_app_config" <<'NODE'
const port = Number(process.argv[2]);
process.stdout.write(`${JSON.stringify({
  gateway: {
    mode: "remote",
    port,
    auth: { mode: "none" },
    nodes: { commands: { allow: ["computer.act"] } },
    remote: { transport: "direct", url: `ws://127.0.0.1:${port}` },
  },
}, null, 2)}\n`);
NODE

  mkdir -p "$app_state"
  cp "$staged_app_config" "$app_config"
  chmod 600 "$app_config" "$gateway_config"

  defaults write "$defaults_domain" openclaw.macNodeIdentityProfile -string node
  defaults write "$defaults_domain" openclaw.connectionMode -string remote
  defaults write "$defaults_domain" openclaw.pauseEnabled -bool false
  defaults write "$defaults_domain" openclaw.computerControlEnabled -bool true
  defaults write "$defaults_domain" openclaw.computerControlProvider -string "$provider"
  defaults write "$defaults_domain" openclaw.gatewayProjectRootPath -string "$repo_root"
  defaults write "$defaults_domain" openclaw.onboardingSeen -bool true
  defaults write "$defaults_domain" openclaw.onboardingVersion -int 8

  node - "$repo_root" "$profile" "$port" "$app_path" "$app_state" "$gateway_config" "$scratch/agent-state" >"$scratch/rig.json" <<'NODE'
const [root, profile, port, app, appState, gatewayConfig, agentState] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ root, profile, port: Number(port), app, appState, gatewayConfig, agentState }, null, 2)}\n`);
NODE
  chmod 600 "$scratch/rig.json"

  echo "prepared isolated profile $profile on ws://127.0.0.1:$port"
  echo "gateway: $0 gateway $scratch"
  echo "app:     $0 app $scratch $provider"
  echo "nodes:   $0 nodes $scratch"
}

run_gateway() {
  [[ $# -eq 1 ]] || { usage; exit 2; }
  load_rig "$1"
  require_unoccupied_port "$OPENCLAW_CU_RIG_PORT"
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_APP_STATE" \
    node "$repo_root/scripts/run-node.mjs" --profile "$OPENCLAW_CU_RIG_PROFILE" \
      gateway run --port "$OPENCLAW_CU_RIG_PORT" --auth none --verbose
}

run_app() {
  [[ $# -ge 1 && $# -le 2 ]] || { usage; exit 2; }
  load_rig "$1"
  local provider="${2:-peekaboo}"
  validate_provider "$provider"
  defaults write "ai.openclaw.mac.profile.$OPENCLAW_CU_RIG_PROFILE" \
    openclaw.computerControlProvider -string "$provider"
  exec env OPENCLAW_PROFILE="$OPENCLAW_CU_RIG_PROFILE" \
    "$OPENCLAW_CU_RIG_APP/Contents/MacOS/OpenClaw"
}

run_nodes() {
  [[ $# -eq 1 ]] || { usage; exit 2; }
  load_rig "$1"
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_AGENT_STATE" \
    node "$repo_root/scripts/run-node.mjs" nodes list --json
}

run_proof() {
  [[ $# -ge 4 && $# -le 5 ]] || { usage; exit 2; }
  local scratch="$1"
  load_rig "$scratch"
  local provider="$2"
  validate_provider "$provider"
  local args=(
    --provider "$provider"
    --window-title "$3"
    --text "$4"
    --artifacts "$scratch"
  )
  if [[ $# -eq 5 ]]; then
    args+=(--element-label "$5")
  fi
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_AGENT_STATE" \
    node --import tsx "$repo_root/scripts/dev/computer-use-macos-live-proof.ts" "${args[@]}"
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage; exit 2; }
shift
case "$command_name" in
  prepare) prepare "$@" ;;
  gateway) run_gateway "$@" ;;
  app) run_app "$@" ;;
  nodes) run_nodes "$@" ;;
  proof) run_proof "$@" ;;
  -h | --help | help) usage ;;
  *) usage; exit 2 ;;
esac
