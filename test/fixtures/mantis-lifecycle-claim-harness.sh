#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" != "0" && "${OPENCLAW_MANTIS_TEST_USER_NAMESPACE:-}" != "1" ]]; then
  exec env OPENCLAW_MANTIS_TEST_USER_NAMESPACE=1 \
    /usr/bin/unshare --user --map-root-user /bin/bash "$0" "$@"
fi

wrapper="$1"
mode="$2"
claim_loss_stage="$3"
output_root="$4"
mkdir -p "$output_root"

safe_runtime="$output_root/safe-runtime"
claim_root="$output_root/claim-root"
fake_bin="$output_root/bin"
mkdir -p "$safe_runtime" "$claim_root/claims" "$fake_bin"
: >"$safe_runtime/lifecycle-control.lock"

container_name="openclaw-telegram-sut-11111111-1111-4111-8111-111111111111"
runtime_source_fixture="/tmp/openclaw-tg-crabbox-sut-claimfence$$"
claim_file="$claim_root/claims/$container_name.claim"
docker_calls="$output_root/docker-calls.log"
controller_calls="$output_root/controller-calls.log"
request_file="$output_root/request-id"
action_file="$output_root/action-fired"
gateway_port_file="$safe_runtime/gateway-port"
zombie_state_file="$output_root/zombie-state"
owner_pid_file="$output_root/claim-owner-pid"
owner_reaped_file="$output_root/claim-owner-reaped"

export CLAIM_FILE_FIXTURE="$claim_file"
export PORT_FILE_FIXTURE="$gateway_port_file"
cat >"$fake_bin/stat" <<'EOF'
#!/bin/bash
if [[ "$1" == "-c" && "$2" == "%u" \
  && ( "$3" == "$CLAIM_FILE_FIXTURE" || "$3" == "$PORT_FILE_FIXTURE" ) ]]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$fake_bin/stat"

cat >"$fake_bin/docker" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>'$docker_calls'
: >'$action_file'
if [[ '$claim_loss_stage' == 'after' ]]; then
  rm -f -- '$claim_file'
  printf '%s\t99999999\t1\t1\n' '$runtime_source_fixture' >'$claim_file'
  chmod 0400 '$claim_file'
fi
exit 0
EOF
chmod 0755 "$fake_bin/docker"

cat >"$fake_bin/claim-owner.py" <<'PY'
#!/usr/bin/python3
import os
import signal
import sys
import time

pid_file, reaped_file = sys.argv[1:]
child_pid = os.fork()
if child_pid == 0:
    os.setsid()
    while True:
        signal.pause()

for _ in range(1000):
    try:
        if os.getpgid(child_pid) == child_pid:
            break
    except ProcessLookupError:
        raise SystemExit(91)
    time.sleep(0.001)
else:
    raise SystemExit(92)

child_reaped = False

def reap_child() -> None:
    global child_reaped
    if child_reaped:
        return
    try:
        os.killpg(child_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(child_pid, 0)
    child_reaped = True
    with open(reaped_file, "w", encoding="utf-8") as handle:
        handle.write(f"{child_pid}\n")

def reap_only(_signum: int, _frame: object) -> None:
    reap_child()

def reap_and_exit(_signum: int, _frame: object) -> None:
    reap_child()
    raise SystemExit(0)

signal.signal(signal.SIGUSR1, reap_only)
signal.signal(signal.SIGTERM, reap_and_exit)
with open(pid_file, "x", encoding="utf-8") as handle:
    handle.write(f"{child_pid}\n")
while True:
    signal.pause()
PY
chmod 0755 "$fake_bin/claim-owner.py"

if ! command -v jq >/dev/null 2>&1; then
  cat >"$fake_bin/jq" <<'PY'
#!/usr/bin/python3
import json
import sys

query = sys.argv[-1]
value = json.load(sys.stdin)
fallback_empty = query.endswith(' // ""')
if fallback_empty:
    query = query[:-6]
for key in query.removeprefix(".").split("."):
    if not isinstance(value, dict) or key not in value:
        value = None
        break
    value = value[key]
if value is None and fallback_empty:
    value = ""
if value is None:
    raise SystemExit(1)
if isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
  chmod 0755 "$fake_bin/jq"
fi
export PATH="$fake_bin:$PATH"

claim_functions="$(awk '
  /^runtime_claim_path\(\) \{/ { capture=1 }
  /^container_security_args=\(/ { capture=0 }
  capture { print }
' "$wrapper")"
port_functions="$(awk '
  /^require_port\(\) \{/ { capture=1 }
  /^require_positive_integer\(\) \{/ { capture=0 }
  capture { print }
' "$wrapper")"
lifecycle_body="$(awk '
  /^  __lifecycle\)$/ { capture=1; next }
  capture && /^    ;;/ { exit }
  capture { print }
' "$wrapper")"

die() {
  echo "mantis SUT container: $*" >&2
  exit 64
}

runtime_parent_path() {
  printf '%s\n' "$claim_root"
}

eval "$claim_functions"
eval "$port_functions"

readonly docker_bin="$fake_bin/docker"
readonly flock_bin=/bin/true

require_cleanup_timeout_parent() { :; }
require_container_name() { :; }
require_positive_integer() { :; }
require_readiness_timeout() { :; }
locked_runtime_root() { printf '%s\n' "$safe_runtime"; }
open_lifecycle_lock() {
  exec 9>"$safe_runtime/lifecycle-control.lock"
  printf -v "$2" '%s' 9
}
gateway_boundary_calls=0
require_gateway_action_boundary_ready() {
  gateway_boundary_calls=$((gateway_boundary_calls + 1))
  if [[ "$claim_loss_stage" == "success" && "$gateway_boundary_calls" == "2" ]]; then
    rm -f -- "$claim_file"
    printf '%s\t99999999\t1\t1\n' "$runtime_source_fixture" >"$claim_file"
    chmod 0400 "$claim_file"
  fi
}
require_container_continuity() { :; }

initial_state='{"containerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":1,"mockContainerId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","phase":"ready","proxyContainerId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'

terminate_claim_owner() {
  kill -USR1 "$claim_helper_pid"
  for _ in {1..100}; do
    [[ ! -r "/proc/$claim_owner_pid/stat" ]] && return 0
    /bin/sleep 0.01
  done
  return 1
}

make_claim_owner_zombie() {
  if [[ -n "${claim_owner_pid:-}" ]] && kill -0 "$claim_owner_pid" 2>/dev/null; then
    kill -KILL -- "-$claim_owner_pgid" 2>/dev/null || true
    for _ in {1..100}; do
      if read_process_identity "$claim_owner_pid" && [[ "$process_state" == "Z" ]]; then
        printf '%s\n' "$process_state" >"$zombie_state_file"
        return 0
      fi
      /bin/sleep 0.01
    done
  fi
  return 1
}

cleanup_claim_owner() {
  if [[ -n "${claim_helper_pid:-}" ]]; then
    kill -TERM "$claim_helper_pid" 2>/dev/null || true
    wait "$claim_helper_pid" 2>/dev/null || true
  fi
}

run_lifecycle_controller() {
  local operation="$1"
  printf '%s\n' "$*" >>"$controller_calls"
  case "$operation" in
    status)
      if [[ ! -f "$request_file" ]]; then
        printf '%s\n' "$initial_state"
      elif [[ ! -f "$action_file" ]]; then
        local pending_request_id
        pending_request_id="$(<"$request_file")"
        printf '{"activeRequest":{"id":"%s"},"generation":1,"phase":"restart-requested"}\n' \
          "$pending_request_id"
      else
        local ready_request_id
        ready_request_id="$(<"$request_file")"
        printf '{"causedByRequestId":"%s","containerId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","generation":2,"mockContainerId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","phase":"ready","proxyContainerId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","schemaVersion":1,"sequence":9}\n' \
          "$ready_request_id"
      fi
      ;;
    request)
      printf '%s\n' "$6" >"$request_file"
      if [[ "$claim_loss_stage" == "before" ]]; then
        terminate_claim_owner
      elif [[ "$claim_loss_stage" == "zombie" ]]; then
        make_claim_owner_zombie
      fi
      ;;
    request-failed)
      rm -f "$request_file"
      ;;
    dependency-failed)
      return 94
      ;;
    *)
      echo "unexpected lifecycle controller operation: $operation" >&2
      return 93
      ;;
  esac
}

/usr/bin/python3 "$fake_bin/claim-owner.py" "$owner_pid_file" "$owner_reaped_file" &
claim_helper_pid=$!
for _ in {1..100}; do
  [[ -s "$owner_pid_file" ]] && break
  /bin/sleep 0.01
done
claim_owner_pid="$(<"$owner_pid_file")"
read_process_identity "$claim_owner_pid"
claim_owner_pgid="$process_pgid"
claim_owner_start="$process_start"
trap cleanup_claim_owner EXIT INT TERM
printf '%s\t%s\t%s\t%s\n' \
  "$runtime_source_fixture" "$claim_owner_pid" "$claim_owner_pgid" "$claim_owner_start" \
  >"$claim_file"
chmod 0400 "$claim_file"
printf '18789\n' >"$gateway_port_file"
chmod 0400 "$gateway_port_file"

set -- "$container_name" "$runtime_source_fixture" 1 "$mode" 5
eval "$lifecycle_body"
