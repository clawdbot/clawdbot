#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/computer-use-macos-live-rig.sh prepare <profile> <port> <app> <scratch> [peekaboo|cua]
  scripts/dev/computer-use-macos-live-rig.sh prepare-linux <profile> <port> <scratch>
  scripts/dev/computer-use-macos-live-rig.sh gateway <scratch>
  scripts/dev/computer-use-macos-live-rig.sh app <scratch> [peekaboo|cua]
  scripts/dev/computer-use-macos-live-rig.sh node <scratch>
  scripts/dev/computer-use-macos-live-rig.sh fixture <scratch> <target-title> <sentinel-title> <before-text>
  scripts/dev/computer-use-macos-live-rig.sh nodes <scratch>
  scripts/dev/computer-use-macos-live-rig.sh approve <scratch> <request-id>
  scripts/dev/computer-use-macos-live-rig.sh proof <scratch> <peekaboo|cua> <window-title> <text> [element-label]

The rig is maintainer-only and loopback-only. On macOS, run gateway and app in
separate terminals. On Linux X11, run gateway, node, and fixture in separate
terminals that share DISPLAY and DBUS_SESSION_BUS_ADDRESS. Approve the isolated
node command surface after its first request, then run proof. Never use the
operator profile or port 18789. Native Wayland is intentionally unsupported.
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
  if ! node - "$port" >/dev/null 2>&1 <<'NODE'; then
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close());
NODE
    fail "port $port already has a listener; choose a fresh proof port"
  fi
}

require_linux_x11() {
  [[ "$(uname -s)" == "Linux" ]] || fail "Linux proof must run on a Linux host"
  [[ "${XDG_SESSION_TYPE:-}" != "wayland" && -z "${WAYLAND_DISPLAY:-}" ]] ||
    fail "native Wayland is out of scope; switch to an X11 session"
  [[ -n "${DISPLAY:-}" ]] || fail "DISPLAY is required for Linux X11 proof"
  command -v xdpyinfo >/dev/null || fail "xdpyinfo is required for Linux X11 proof"
  command -v xdotool >/dev/null || fail "xdotool is required for Linux X11 proof"
  xdpyinfo >/dev/null 2>&1 || fail "DISPLAY does not resolve to a live X11 server"
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
const macKeys = ["root", "profile", "port", "app", "appState", "gatewayConfig", "agentState"];
const linuxKeys = [
    "platform", "root", "profile", "port", "gatewayConfig", "gatewayState",
    "agentState", "nodeConfig", "nodeState", "display",
  ];
try {
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  const actualKeys = Object.keys(value).sort();
  const isMac = actualKeys.join("\0") === [...macKeys].sort().join("\0");
  const isLinux = actualKeys.join("\0") === [...linuxKeys].sort().join("\0");
  if (!isMac && !isLinux) throw new Error("unexpected fields");
  if (!Number.isInteger(value.port)) throw new Error("port must be an integer");
  if (isLinux && value.platform !== "linux") throw new Error("invalid platform");
  const fields = isMac
    ? ["macos", value.root, value.profile, String(value.port), value.app, value.appState,
        value.gatewayConfig, value.agentState, "", "", "", value.appState]
    : [value.platform, value.root, value.profile, String(value.port), "", "",
        value.gatewayConfig, value.agentState, value.nodeConfig, value.nodeState,
        value.display, value.gatewayState];
  if (fields.some((field) => typeof field !== "string" || field.includes("\0"))) throw new Error("invalid field");
  process.stdout.write(`${fields.join("\0")}\0`);
} catch (error) {
  console.error(`invalid rig state: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
NODE
  )
  [[ ${#rig_values[@]} -eq 12 ]] || fail "invalid $rig_path"
  OPENCLAW_CU_RIG_PLATFORM="${rig_values[0]}"
  OPENCLAW_CU_RIG_ROOT="${rig_values[1]}"
  OPENCLAW_CU_RIG_PROFILE="${rig_values[2]}"
  OPENCLAW_CU_RIG_PORT="${rig_values[3]}"
  OPENCLAW_CU_RIG_APP="${rig_values[4]}"
  OPENCLAW_CU_RIG_APP_STATE="${rig_values[5]}"
  OPENCLAW_CU_RIG_GATEWAY_CONFIG="${rig_values[6]}"
  OPENCLAW_CU_RIG_AGENT_STATE="${rig_values[7]}"
  OPENCLAW_CU_RIG_NODE_CONFIG="${rig_values[8]}"
  OPENCLAW_CU_RIG_NODE_STATE="${rig_values[9]}"
  OPENCLAW_CU_RIG_DISPLAY="${rig_values[10]}"
  OPENCLAW_CU_RIG_GATEWAY_STATE="${rig_values[11]}"
  [[ "$OPENCLAW_CU_RIG_ROOT" == "$repo_root" ]] ||
    fail "rig belongs to a different checkout: $OPENCLAW_CU_RIG_ROOT"
  [[ "$OPENCLAW_CU_RIG_PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]+$ ]] || fail "invalid rig profile"
  [[ "$OPENCLAW_CU_RIG_PORT" =~ ^[0-9]+$ ]] || fail "invalid rig port"
  ((OPENCLAW_CU_RIG_PORT >= 1024 && OPENCLAW_CU_RIG_PORT <= 65535)) || fail "invalid rig port"
  ((OPENCLAW_CU_RIG_PORT != 18789)) || fail "operator port is not valid rig state"
  [[ "$OPENCLAW_CU_RIG_GATEWAY_CONFIG" == "$scratch/gateway.json" ]] ||
    fail "rig gateway config is outside its scratch directory"
  [[ "$OPENCLAW_CU_RIG_AGENT_STATE" == "$scratch/agent-state" ]] ||
    fail "rig agent state is outside its scratch directory"
  case "$OPENCLAW_CU_RIG_PLATFORM" in
    macos)
      [[ "$OPENCLAW_CU_RIG_APP" = /* ]] || fail "invalid rig app path"
      [[ "$OPENCLAW_CU_RIG_APP_STATE" == "$HOME/.openclaw-$OPENCLAW_CU_RIG_PROFILE" ]] ||
        fail "rig app state does not match its profile"
      [[ "$OPENCLAW_CU_RIG_GATEWAY_STATE" == "$OPENCLAW_CU_RIG_APP_STATE" ]] ||
        fail "invalid macOS gateway state"
      ;;
    linux)
      [[ "$OPENCLAW_CU_RIG_NODE_CONFIG" == "$scratch/node.json" ]] ||
        fail "rig node config is outside its scratch directory"
      [[ "$OPENCLAW_CU_RIG_NODE_STATE" == "$scratch/node-state" ]] ||
        fail "rig node state is outside its scratch directory"
      [[ "$OPENCLAW_CU_RIG_GATEWAY_STATE" == "$scratch/gateway-state" ]] ||
        fail "rig gateway state is outside its scratch directory"
      [[ -n "$OPENCLAW_CU_RIG_DISPLAY" ]] || fail "invalid Linux display"
      ;;
    *) fail "invalid rig platform" ;;
  esac
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

  git -C "$repo_root" diff --quiet -- src packages extensions scripts ||
    fail "runtime sources are dirty; commit and rebuild before launching the node worker"
  git -C "$repo_root" diff --cached --quiet -- src packages extensions scripts ||
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

prepare_linux() {
  [[ $# -eq 3 ]] || { usage; exit 2; }
  local profile="$1"
  local port="$2"
  local scratch="$3"

  require_linux_x11
  [[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9_-]+$ ]] ||
    fail "profile must contain only letters, digits, underscores, and dashes"
  case "$profile" in
    default | main | local) fail "choose a fresh, explicitly isolated profile" ;;
  esac
  [[ "$port" =~ ^[0-9]+$ ]] || fail "port must be numeric"
  ((port >= 1024 && port <= 65535)) || fail "port must be between 1024 and 65535"
  ((port != 18789)) || fail "port 18789 belongs to the operator gateway"
  [[ "$scratch" = /* ]] || fail "scratch path must be absolute"
  require_unoccupied_port "$port"

  git -C "$repo_root" diff --quiet -- src packages extensions scripts ||
    fail "runtime sources are dirty; commit and rebuild before launching the node worker"
  git -C "$repo_root" diff --cached --quiet -- src packages extensions scripts ||
    fail "runtime sources are staged but uncommitted; commit and rebuild first"

  [[ ! -e "$scratch/rig.json" ]] || fail "$scratch already contains a rig"
  mkdir -p "$scratch/agent-state" "$scratch/gateway-state" "$scratch/node-state"
  local gateway_config="$scratch/gateway.json"
  local node_config="$scratch/node.json"
  local gateway_token
  gateway_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

  node - "$port" "$gateway_token" >"$gateway_config" <<'NODE'
const port = Number(process.argv[2]);
const token = process.argv[3];
process.stdout.write(`${JSON.stringify({
  gateway: {
    mode: "local",
    port,
    auth: { mode: "token", token },
    nodes: {
      commands: { allow: ["computer.act"] },
      pairing: { autoApproveLocal: true, sshVerify: false },
    },
  },
}, null, 2)}\n`);
NODE

  node - "$port" "$gateway_token" >"$node_config" <<'NODE'
const port = Number(process.argv[2]);
const token = process.argv[3];
process.stdout.write(`${JSON.stringify({
  gateway: {
    mode: "remote",
    remote: { transport: "direct", url: `ws://127.0.0.1:${port}`, token },
  },
  browser: { enabled: false },
  nodeHost: { browserProxy: { enabled: false } },
  plugins: { entries: { "cua-computer": { enabled: true } } },
}, null, 2)}\n`);
NODE

  node - "$repo_root" "$profile" "$port" "$gateway_config" "$scratch/gateway-state" \
    "$scratch/agent-state" "$node_config" "$scratch/node-state" "$DISPLAY" >"$scratch/rig.json" <<'NODE'
const [root, profile, port, gatewayConfig, gatewayState, agentState, nodeConfig, nodeState, display] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  platform: "linux",
  root,
  profile,
  port: Number(port),
  gatewayConfig,
  gatewayState,
  agentState,
  nodeConfig,
  nodeState,
  display,
}, null, 2)}\n`);
NODE
  chmod 600 "$gateway_config" "$node_config" "$scratch/rig.json"

  echo "prepared isolated Linux X11 profile $profile on ws://127.0.0.1:$port ($DISPLAY)"
  echo "gateway: $0 gateway $scratch"
  echo "node:    $0 node $scratch"
  echo "fixture: $0 fixture $scratch 'OpenClaw CUA X11 Target' 'OpenClaw X11 Sentinel' 'W3-LINUX BEFORE'"
  echo "nodes:   $0 nodes $scratch"
}

run_gateway() {
  [[ $# -eq 1 ]] || { usage; exit 2; }
  load_rig "$1"
  require_unoccupied_port "$OPENCLAW_CU_RIG_PORT"
  local auth_mode="none"
  [[ "$OPENCLAW_CU_RIG_PLATFORM" == "linux" ]] && auth_mode="token"
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_GATEWAY_STATE" \
    node "$repo_root/scripts/run-node.mjs" --profile "$OPENCLAW_CU_RIG_PROFILE" \
      gateway run --port "$OPENCLAW_CU_RIG_PORT" --auth "$auth_mode" --verbose
}

run_app() {
  [[ $# -ge 1 && $# -le 2 ]] || { usage; exit 2; }
  load_rig "$1"
  [[ "$OPENCLAW_CU_RIG_PLATFORM" == "macos" ]] || fail "app is available only for macOS rigs"
  local provider="${2:-peekaboo}"
  validate_provider "$provider"
  defaults write "ai.openclaw.mac.profile.$OPENCLAW_CU_RIG_PROFILE" \
    openclaw.computerControlProvider -string "$provider"
  exec env OPENCLAW_PROFILE="$OPENCLAW_CU_RIG_PROFILE" \
    "$OPENCLAW_CU_RIG_APP/Contents/MacOS/OpenClaw"
}

run_node() {
  [[ $# -eq 1 ]] || { usage; exit 2; }
  load_rig "$1"
  [[ "$OPENCLAW_CU_RIG_PLATFORM" == "linux" ]] || fail "node is available only for Linux rigs"
  require_linux_x11
  [[ "$DISPLAY" == "$OPENCLAW_CU_RIG_DISPLAY" ]] || fail "DISPLAY does not match rig state"
  exec env \
    DISPLAY="$OPENCLAW_CU_RIG_DISPLAY" \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_NODE_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_NODE_STATE" \
    node "$repo_root/scripts/run-node.mjs" --profile "$OPENCLAW_CU_RIG_PROFILE" \
      node run --host 127.0.0.1 --port "$OPENCLAW_CU_RIG_PORT" \
      --display-name "OpenClaw CUA X11 Live Proof"
}

run_fixture() {
  [[ $# -eq 4 ]] || { usage; exit 2; }
  local scratch="$1"
  load_rig "$scratch"
  [[ "$OPENCLAW_CU_RIG_PLATFORM" == "linux" ]] || fail "fixture is available only for Linux rigs"
  require_linux_x11
  [[ "$DISPLAY" == "$OPENCLAW_CU_RIG_DISPLAY" ]] || fail "DISPLAY does not match rig state"
  command -v python3 >/dev/null || fail "python3 is required for the Linux proof fixture"
  command -v xmessage >/dev/null || fail "xmessage is required for the Linux proof sentinel"

  local target_title="$2"
  local sentinel_title="$3"
  local before_text="$4"
  local target_pid sentinel_pid target_window sentinel_window
  python3 "$repo_root/scripts/dev/computer-use-linux-x11-fixture.py" \
    --title "$target_title" --text "$before_text" &
  target_pid=$!
  xmessage -title "$sentinel_title" "This window must remain frontmost during proof." &
  sentinel_pid=$!
  trap 'kill "$target_pid" "$sentinel_pid" >/dev/null 2>&1 || true' EXIT INT TERM

  for _ in {1..100}; do
    target_window="$(xdotool search --name "$target_title" 2>/dev/null | head -n 1 || true)"
    sentinel_window="$(xdotool search --name "$sentinel_title" 2>/dev/null | head -n 1 || true)"
    [[ -n "$target_window" && -n "$sentinel_window" ]] && break
    sleep 0.1
  done
  [[ -n "$target_window" && -n "$sentinel_window" ]] || fail "fixture windows did not appear"
  xdotool windowactivate --sync "$sentinel_window"
  echo "fixture ready: target=$target_window sentinel=$sentinel_window"
  wait "$target_pid"
}

run_nodes() {
  [[ $# -eq 1 ]] || { usage; exit 2; }
  load_rig "$1"
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_AGENT_STATE" \
    node "$repo_root/scripts/run-node.mjs" nodes list --json
}

run_approve() {
  [[ $# -eq 2 ]] || { usage; exit 2; }
  load_rig "$1"
  exec env \
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CU_RIG_GATEWAY_CONFIG" \
    OPENCLAW_STATE_DIR="$OPENCLAW_CU_RIG_AGENT_STATE" \
    node "$repo_root/scripts/run-node.mjs" nodes approve "$2" --json
}

run_proof() {
  [[ $# -ge 4 && $# -le 5 ]] || { usage; exit 2; }
  local scratch="$1"
  load_rig "$scratch"
  local provider="$2"
  validate_provider "$provider"
  if [[ "$OPENCLAW_CU_RIG_PLATFORM" == "linux" ]]; then
    [[ "$provider" == "cua" ]] || fail "Linux rig supports only the CUA provider"
    require_linux_x11
    [[ "$DISPLAY" == "$OPENCLAW_CU_RIG_DISPLAY" ]] || fail "DISPLAY does not match rig state"
  fi
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
  prepare-linux) prepare_linux "$@" ;;
  gateway) run_gateway "$@" ;;
  app) run_app "$@" ;;
  node) run_node "$@" ;;
  fixture) run_fixture "$@" ;;
  nodes) run_nodes "$@" ;;
  approve) run_approve "$@" ;;
  proof) run_proof "$@" ;;
  -h | --help | help) usage ;;
  *) usage; exit 2 ;;
esac
