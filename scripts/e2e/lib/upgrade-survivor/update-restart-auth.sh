#!/usr/bin/env bash

install_update_restart_systemctl_shim() {
  local shim_dir="$npm_config_prefix/bin"
  mkdir -p "$shim_dir"
  cp "$(dirname "${BASH_SOURCE[0]}")/systemd-fixture.mjs" "$shim_dir/systemd-fixture.mjs"
  cat >"$shim_dir/busctl" <<'BUSCTL'
#!/usr/bin/env bash
exec node "$(dirname "$0")/systemd-fixture.mjs" busctl "$@"
BUSCTL
  cat >"$shim_dir/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

log_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}"
pid_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}"
daemon_log="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}"
supervisor_script="${pid_file}.supervisor.mjs"
manager_script="$(dirname "$0")/systemd-fixture.mjs"
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
unit_name="${filtered[1]:-}"
if [ "${#filtered[@]}" -gt 2 ] ||
  { [ -n "$unit_name" ] && [ "$unit_name" != openclaw-gateway.service ] && [ "$unit_name" != openclaw.service ]; }; then
  echo "systemctl shim unsupported unit or arguments: $*" >&2
  exit 1
fi

is_running() {
  [ -s "$pid_file" ] || return 1
  local pid stat_line stat_tail
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  stat_line="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
  stat_tail="${stat_line##*) }"
  [[ "$stat_line" == "$pid ("*") $stat_tail" &&
    "$stat_tail" =~ ^Z([[:space:]]+-?[0-9]+){49,}$ ]] && return 1
  return 0
}

stop_gateway() {
  local pid=""
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    # The supervisor gives its child 30s, so keep this outer deadline comfortably longer.
    for _ in $(seq 1 350); do
      is_running || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file" "$supervisor_script"
}

unit_path() {
  printf '%s/.config/systemd/user/openclaw-gateway.service\n' "${HOME:?missing HOME}"
}

start_gateway() {
  local exec_start
  exec_start="$(node "$manager_script" command)"
  rm -f "$pid_file" "$supervisor_script"
  rm -f "${daemon_log}.exit.json"
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
let firstExit;
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
  child = spawn("bash", ["-c", command], {
    detached: true,
    env: childEnv,
    stdio: ["ignore", output, output],
  });
  activeGroupPid = child.pid;
  const childGroupPid = activeGroupPid;
  child.on("error", (error) => {
    fs.writeSync(output, `[systemctl-shim] gateway spawn failed: ${String(error)}\n`);
  });
  child.once("close", (code, signal) => {
    const observed = { code, signal, at: new Date().toISOString() };
    firstExit ??= observed;
    try {
      fs.writeFileSync(`${daemonLog}.exit.json`, JSON.stringify({
        first: firstExit, last: observed, cwd: process.cwd(),
      }));
    } catch {
      fs.writeSync(output, "[systemctl-shim] child exit diagnostic could not be retained\n");
    }
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
    OPENCLAW_SYSTEMCTL_SHIM_EXEC_START="$exec_start" \
      OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG="$daemon_log" \
      nohup node "$supervisor_script" </dev/null >>"${daemon_log}.bootstrap.log" 2>&1 &
    printf '%s\n' "$!" >"$pid_file"
  )
}

case "$command" in
  daemon-reload)
    [ "$system_scope" = 0 ] && [ -z "$unit_name" ] || exit 1
    node "$manager_script" reload
    exit 0
    ;;
  enable | disable | reset-failed)
    [ "$system_scope" = 0 ] && [ "$unit_name" = openclaw-gateway.service ] || exit 1
    [ -f "$(unit_path)" ] || exit 1
    if [ "$command" = enable ]; then
      mkdir -p "$(dirname "$(unit_path)")/default.target.wants"
      ln -sf ../openclaw-gateway.service "$(dirname "$(unit_path)")/default.target.wants/openclaw-gateway.service"
    elif [ "$command" = disable ]; then
      stop_gateway
      rm -f "$(dirname "$(unit_path)")/default.target.wants/openclaw-gateway.service"
    fi
    exit 0
    ;;
  status)
    [ "$system_scope" = 0 ] || exit 1
    [ -z "$unit_name" ] && exit 0
    [ "$unit_name" = openclaw-gateway.service ] && is_running && exit 0
    exit 3
    ;;
  stop)
    [ "$system_scope" = 0 ] && [ "$unit_name" = openclaw-gateway.service ] || exit 1
    stop_gateway
    exit 0
    ;;
  restart | start)
    [ "$system_scope" = 0 ] && [ "$unit_name" = openclaw-gateway.service ] || exit 1
    stop_gateway
    start_gateway
    exit 0
    ;;
  is-enabled)
    [ "$system_scope" = 0 ] && [ "$unit_name" = openclaw-gateway.service ] &&
      [ -f "$(unit_path)" ] && [ -L "$(dirname "$(unit_path)")/default.target.wants/openclaw-gateway.service" ] && exit 0
    printf 'disabled\n'
    exit 1
    ;;
  is-active)
    [ "$system_scope" = 0 ] && [ "$unit_name" = openclaw-gateway.service ] || exit 1
    is_running && exit 0
    exit 3
    ;;
  show)
    if [ "$system_scope" = "1" ]; then
      case "$property" in
        LoadState)
          [ -n "$unit_name" ] || exit 1
          printf 'not-found\n'
          ;;
        UnitPath)
          [ -z "$unit_name" ] || exit 1
          printf '/etc/systemd/system /usr/lib/systemd/system\n'
          ;;
        *)
          echo "systemctl shim unsupported system-scope show: $*" >&2
          exit 1
          ;;
      esac
      exit 0
    fi
    [ "$unit_name" = openclaw-gateway.service ] || exit 1
    [ "$property" = 'Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent' ] || {
      echo "systemctl shim unsupported user-scope show: $*" >&2
      exit 1
    }
    if is_running; then
      printf 'ActiveState=active\nSubState=running\nMainPID=%s\n' "$(cat "$pid_file")"
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\n'
    fi
    # Missing observations stay unknown, including bootstrap failures.
    node - "${daemon_log}.exit.json" <<'EXIT_STATUS'
const fs = require("node:fs");
try {
  const { last } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (Number.isInteger(last.code) && last.code >= 0 && last.code <= 255) {
    process.stdout.write(`ExecMainStatus=${last.code}\nExecMainCode=exited\n`);
  }
} catch {}
EXIT_STATUS
    exit 0
    ;;
  *)
    echo "systemctl shim unsupported command: $*" >&2
    exit 1
    ;;
esac
SHIM
  chmod +x "$shim_dir/systemctl" "$shim_dir/busctl"
  export PATH="$shim_dir:$PATH"
}

assert_update_restart_service_replaced() {
  local previous_pid="$1" previous_log_lines="$2" current_pid
  current_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
  if [ "$current_pid" = "$previous_pid" ] ||
    ! systemctl --user is-active --quiet openclaw-gateway.service ||
    ! tail -n +"$((previous_log_lines + 1))" "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG" |
      grep -Fx -- '--user restart openclaw-gateway.service' >/dev/null; then
    echo "Update did not replace the managed gateway supervisor through restart." >&2
    return 1
  fi
  echo "Update-owned fixture restart replaced supervisor $previous_pid with $current_pid."
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
  local authored_config="${log_file}.authored-config"
  local parking_helper="${OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER:-scripts/e2e/lib/upgrade-survivor/config-parking.mjs}"
  local failure_stage=""
  local probe_status=0
  local restore_status=0
  local start_epoch
  local ready_epoch

  echo "Preparing candidate-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  # Service installation persists OPENCLAW_CONFIG_PATH, so isolate the canonical file in place.
  # Reload stays off through service setup; restoring authored bytes cannot restart this probe.
  node "$parking_helper" \
    park-restart-probe "$OPENCLAW_CONFIG_PATH" "$authored_config" "$port" || probe_status=$?
  if [ "$probe_status" -ne 0 ]; then
    echo "failed to park authored config for candidate restart probe" >&2
    if [ -e "$authored_config" ]; then
      node "$parking_helper" restore "$OPENCLAW_CONFIG_PATH" "$authored_config" ||
        restore_status=$?
    fi
    if [ "$restore_status" -ne 0 ]; then
      return "$restore_status"
    fi
    return "$probe_status"
  fi
  # This setup pass migrates candidate device identity while deferring plugin convergence.
  # Parent-write support lets that migration persist before the real update begins.
  openclaw_e2e_maybe_timeout \
    "$command_timeout" \
    env \
    OPENCLAW_UPDATE_IN_PROGRESS=1 \
    OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=1 \
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1 \
    openclaw doctor --fix --non-interactive >"$doctor_log" 2>&1 || {
      probe_status=$?
      failure_stage="doctor"
    }
  if [ "$probe_status" -ne 0 ]; then
    echo "candidate device identity migration failed" >&2
    cat "$doctor_log" >&2 || true
  fi
  if [ "$probe_status" -eq 0 ]; then
    start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
    env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway --port "$port" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
    gateway_pid="$!"
    printf '%s\n' "$gateway_pid" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
    openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_file" 360 "$port" || {
      probe_status=$?
      failure_stage="readiness"
    }
  fi
  if [ "$probe_status" -eq 0 ]; then
    ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
    start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
    write_update_restart_service_auth_env || {
      probe_status=$?
      failure_stage="service-env"
    }
  fi
  if [ "$probe_status" -eq 0 ]; then
    openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" 2>"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR" || {
      probe_status=$?
      failure_stage="install"
    }
  fi
  if [ "$failure_stage" = "install" ]; then
    echo "gateway service install failed" >&2
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR" >&2 || true
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" >&2 || true
  elif [ "$failure_stage" = "readiness" ]; then
    echo "candidate restart probe gateway did not become ready" >&2
  elif [ "$failure_stage" = "service-env" ]; then
    echo "failed to write candidate restart service environment" >&2
  fi
  node "$parking_helper" restore "$OPENCLAW_CONFIG_PATH" "$authored_config" || restore_status=$?
  if [ "$restore_status" -ne 0 ]; then
    echo "failed to restore authored config after candidate restart probe" >&2
    return "$restore_status"
  fi
  return "$probe_status"
}
