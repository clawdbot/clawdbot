#!/usr/bin/env bash

source scripts/e2e/lib/upgrade-survivor/gateway-start.sh

install_update_restart_systemctl_shim() {
  local shim_dir="$npm_config_prefix/bin"
  local shim_path="$shim_dir/systemctl"
  mkdir -p "$shim_dir"
  cat >"$shim_path" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

log_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}"
pid_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}"
daemon_log="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}"
ownership_file="${pid_file}.ownership"
supervisor_script="${pid_file}.supervisor.mjs"
printf '%s\n' "$*" >>"$log_file"

filtered=()
system_scope=1
property=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --user)
      system_scope=0
      ;;
    --quiet | --no-page | --now | --value)
      ;;
    --property)
      i=$((i + 1))
      property="${!i}"
      ;;
    --property=*)
      property="${arg#--property=}"
      ;;
    *)
      filtered+=("$arg")
      ;;
  esac
done

command="${filtered[0]:-status}"

SHIM
  upgrade_survivor_append_systemctl_process_helpers "$shim_path"
  cat >>"$shim_path" <<'SHIM'
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
  rm -f "$pid_file" "$ownership_file" "$supervisor_script"
  cat >"$supervisor_script" <<'SUPERVISOR'
import fs from "node:fs";
import { spawn } from "node:child_process";

const command = process.env.OPENCLAW_SYSTEMCTL_SHIM_EXEC_START;
const daemonLog = process.env.OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG;
if (!command || !daemonLog) {
  process.exit(2);
}

const output = fs.openSync(daemonLog, "a");
const childEnv = { ...process.env };
delete childEnv.OPENCLAW_SYSTEMCTL_SHIM_EXEC_START;
delete childEnv.OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG;
// systemd does not pass transient systemctl-caller update state into the service.
for (const key of Object.keys(childEnv)) {
  if (key.startsWith("OPENCLAW_UPDATE_")) {
    delete childEnv[key];
  }
}
delete childEnv.OPENCLAW_COMPATIBILITY_HOST_VERSION;
const restartDelayMs = 5_000;
const restartWindowMs = 60_000;
const restartBurst = 5;
const stopTimeoutMs = 30_000;
const starts = [];
let child;
let activeGroupPid;
let drainingGroupPid;
let stopping = false;

const finish = () => {
  try {
    fs.closeSync(output);
  } catch {}
  process.exit(0);
};

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      fs.writeSync(output, `[systemctl-shim] gateway process group ${signal} failed: ${String(error)}\n`);
    }
  }
};

const isProcessGroupRunning = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const drainProcessGroup = (pid, onStopped) => {
  if (!pid) return onStopped();
  if (drainingGroupPid === pid) return;
  drainingGroupPid = pid;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    if (drainingGroupPid === pid) drainingGroupPid = undefined;
    if (activeGroupPid === pid) activeGroupPid = undefined;
    onStopped();
  };
  signalProcessGroup(pid, "SIGTERM");
  const forceKill = setTimeout(() => {
    signalProcessGroup(pid, "SIGKILL");
    complete();
  }, stopTimeoutMs);
  const finishWhenStopped = () => {
    if (completed) return;
    if (isProcessGroupRunning(pid)) {
      setTimeout(finishWhenStopped, 25);
      return;
    }
    clearTimeout(forceKill);
    complete();
  };
  finishWhenStopped();
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  if (drainingGroupPid) return;
  if (activeGroupPid) {
    drainProcessGroup(activeGroupPid, finish);
    return;
  }
  if (child) {
    child.kill("SIGTERM");
    return;
  }
  finish();
};

const start = () => {
  if (stopping) return finish();
  const now = Date.now();
  while (starts.length > 0 && starts[0] <= now - restartWindowMs) {
    starts.shift();
  }
  if (starts.length >= restartBurst) {
    fs.writeSync(output, "[systemctl-shim] gateway restart limit reached\n");
    return finish();
  }
  starts.push(now);
  child = spawn("bash", ["-lc", `exec ${command}`], {
    detached: true,
    env: childEnv,
    stdio: ["ignore", output, output],
  });
  activeGroupPid = child.pid;
  const childGroupPid = activeGroupPid;
  child.on("error", (error) => {
    fs.writeSync(output, `[systemctl-shim] gateway spawn failed: ${String(error)}\n`);
  });
  child.once("close", (code) => {
    child = undefined;
    drainProcessGroup(childGroupPid, () => {
      if (stopping) return finish();
      // Match the generated systemd unit's RestartPreventExitStatus contract.
      if (code === 78) return finish();
      setTimeout(start, restartDelayMs);
    });
  });
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
start();
SUPERVISOR
  (
    load_unit_environment "$unit"
    OPENCLAW_SYSTEMCTL_SHIM_EXEC_START="$exec_start" \
      OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG="$daemon_log" \
      nohup node "$supervisor_script" </dev/null >/dev/null 2>&1 &
    printf '%s\n' "pid" >"$ownership_file"
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
    if [ "$system_scope" = "1" ]; then
      case "$property" in
        LoadState)
          printf 'not-found\n'
          ;;
        UnitPath)
          printf '/etc/systemd/system /usr/lib/systemd/system\n'
          ;;
        *)
          echo "systemctl shim unsupported system-scope show: $*" >&2
          exit 1
          ;;
      esac
      exit 0
    fi
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
  chmod +x "$shim_path"
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
  local command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
  local doctor_log="${log_file}.doctor"
  local start_epoch
  local ready_epoch
  local start_budget
  local absolute_deadline
  local gateway_ownership

  echo "Preparing candidate-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  if ! openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive >"$doctor_log" 2>&1; then
    echo "candidate device identity migration failed" >&2
    cat "$doctor_log" >&2 || true
    return 1
  fi
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
  absolute_deadline=$((SECONDS + start_budget))
  upgrade_survivor_start_gateway_with_convergence_retry \
    gateway_pid "$log_file" 360 "$port" strict "$absolute_deadline" gateway_ownership -- \
    env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD \
    openclaw gateway --port "$port" --bind loopback --allow-unconfigured
  printf '%s\n' "$gateway_ownership" \
    >"${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE}.ownership"
  printf '%s\n' "$gateway_pid" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  write_update_restart_service_auth_env
  if ! openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" 2>"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR"; then
    echo "gateway service install failed" >&2
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR" >&2 || true
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" >&2 || true
    return 1
  fi
}
