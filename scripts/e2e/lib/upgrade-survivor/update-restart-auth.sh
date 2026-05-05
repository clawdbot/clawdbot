#!/usr/bin/env bash

install_update_restart_systemctl_shim() {
  local shim_dir="$npm_config_prefix/bin"
  mkdir -p "$shim_dir"
  cat >"$shim_dir/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

log_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}"
pid_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}"
daemon_log="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}"
printf '%s\n' "$*" >>"$log_file"

filtered=()
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --user | --quiet | --no-page | --now)
      ;;
    --property)
      i=$((i + 1))
      ;;
    *)
      filtered+=("$arg")
      ;;
  esac
done

command="${filtered[0]:-status}"

is_running() {
  [ -s "$pid_file" ] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

stop_gateway() {
  [ -s "$pid_file" ] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

unit_path() {
  printf '%s/.config/systemd/user/openclaw-gateway.service\n' "${HOME:?missing HOME}"
}

load_unit_environment() {
  local unit="$1"
  while IFS= read -r line; do
    case "$line" in
      EnvironmentFile=*)
        local spec="${line#EnvironmentFile=}"
        for token in $spec; do
          local file="${token#-}"
          [ -f "$file" ] || continue
          set -a
          # shellcheck disable=SC1090
          . "$file"
          set +a
        done
        ;;
      Environment=*)
        local assignment="${line#Environment=}"
        assignment="${assignment#\"}"
        assignment="${assignment%\"}"
        export "$assignment"
        ;;
    esac
  done <"$unit"
}

start_gateway() {
  local unit
  local exec_start
  unit="$(unit_path)"
  exec_start="$(sed -n 's/^ExecStart=//p' "$unit" | tail -n 1)"
  [ -n "$exec_start" ] || {
    echo "systemctl shim could not find ExecStart in $unit" >&2
    return 1
  }
  (
    load_unit_environment "$unit"
    nohup bash -lc "exec $exec_start" >>"$daemon_log" 2>&1 &
    printf '%s\n' "$!" >"$pid_file"
  )
}

case "$command" in
  daemon-reload | enable | disable)
    exit 0
    ;;
  status)
    is_running && exit 0
    exit 0
    ;;
  stop)
    stop_gateway
    exit 0
    ;;
  restart | start)
    stop_gateway
    start_gateway
    exit 0
    ;;
  is-enabled)
    exit 0
    ;;
  is-active)
    is_running && exit 0
    exit 3
    ;;
  show)
    if is_running; then
      printf 'ActiveState=active\nSubState=running\nMainPID=%s\nExecMainStatus=0\nExecMainCode=0\n' "$(cat "$pid_file")"
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\nExecMainCode=0\n'
    fi
    exit 0
    ;;
  *)
    echo "systemctl shim unsupported command: $*" >&2
    exit 1
    ;;
esac
SHIM
  chmod +x "$shim_dir/systemctl"
  export PATH="$shim_dir:$PATH"
}

seed_update_restart_probe_device_auth() {
  node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir) {
  throw new Error("missing OPENCLAW_STATE_DIR");
}

const base64UrlEncode = (buf) =>
  buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
const rawPublicKey =
  spki.length === ed25519SpkiPrefix.length + 32 &&
  spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)
    ? spki.subarray(ed25519SpkiPrefix.length)
    : spki;
const publicKeyRaw = base64UrlEncode(rawPublicKey);
const deviceId = crypto.createHash("sha256").update(rawPublicKey).digest("hex");
const token = base64UrlEncode(crypto.randomBytes(32));
const now = Date.now();
const scopes = ["operator.read"];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
  }
}

writeJson(path.join(stateDir, "identity", "device.json"), {
  version: 1,
  deviceId,
  publicKeyPem,
  privateKeyPem,
  createdAtMs: now,
});
writeJson(path.join(stateDir, "identity", "device-auth.json"), {
  version: 1,
  deviceId,
  tokens: {
    operator: {
      token,
      role: "operator",
      scopes,
      updatedAtMs: now,
    },
  },
});
writeJson(path.join(stateDir, "devices", "paired.json"), {
  [deviceId]: {
    deviceId,
    publicKey: publicKeyRaw,
    displayName: "upgrade survivor restart probe",
    platform: process.platform,
    clientId: "openclaw-cli",
    clientMode: "probe",
    role: "operator",
    roles: ["operator"],
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: {
        token,
        role: "operator",
        scopes,
        createdAtMs: now,
      },
    },
    createdAtMs: now,
    approvedAtMs: now,
  },
});
writeJson(path.join(stateDir, "devices", "pending.json"), {});
NODE
}

write_update_restart_service_auth_env() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  local dotenv_path="$OPENCLAW_STATE_DIR/.env"
  local tmp_path="$dotenv_path.tmp.$$"
  if [ -f "$dotenv_path" ]; then
    grep -v '^GATEWAY_AUTH_TOKEN_REF=' "$dotenv_path" >"$tmp_path" || true
  else
    : >"$tmp_path"
  fi
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >>"$tmp_path"
  mv "$tmp_path" "$dotenv_path"
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >"$OPENCLAW_STATE_DIR/gateway.systemd.env"
}

prepare_update_restart_probe_current_install() {
  local port="$1"
  local log_file="$2"
  local start_epoch
  local ready_epoch

  echo "Preparing candidate-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway --port "$port" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  gateway_pid="$!"
  printf '%s\n' "$gateway_pid" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_file" 360
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  write_update_restart_service_auth_env
  if ! env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" 2>"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR"; then
    echo "gateway service install failed" >&2
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR" >&2 || true
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" >&2 || true
    return 1
  fi
}
