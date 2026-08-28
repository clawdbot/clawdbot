#!/bin/bash
set -euo pipefail

wrapper="$1"
port_case="$2"
output_root="$3"

if [[ "$port_case" != "wrong-owner" && "$(id -u)" != "0" \
  && "${OPENCLAW_MANTIS_TEST_USER_NAMESPACE:-}" != "1" ]]; then
  exec env OPENCLAW_MANTIS_TEST_USER_NAMESPACE=1 \
    /usr/bin/unshare --user --map-root-user /bin/bash "$0" "$@"
fi

mkdir -p "$output_root"
safe_runtime="$output_root/safe-runtime"
claim_root="$output_root/claim-root"
fake_bin="$output_root/bin"
mkdir -p "$safe_runtime" "$claim_root/claims" "$fake_bin"
chmod 1770 "$safe_runtime"
/usr/bin/stat -c '%u %a' "$safe_runtime" >"$output_root/runtime-metadata"
: >"$safe_runtime/lifecycle-control.lock"

container_name="openclaw-telegram-sut-22222222-2222-4222-8222-222222222222"
runtime_source_fixture="/tmp/openclaw-tg-crabbox-sut-portcontract$$"
claim_file="$claim_root/claims/$container_name.claim"
gateway_port_file="$safe_runtime/gateway-port"
docker_calls="$output_root/docker-calls.log"
controller_calls="$output_root/controller-calls.log"
request_file="$output_root/request-id"
action_file="$output_root/action-fired"
cleanup_file="$output_root/cleanup-complete"
precreated_preserved_file="$output_root/precreated-preserved"
temp_residue_file="$output_root/temp-residue"

cleanup_runtime() {
  if [[ -d "$safe_runtime" ]]; then
    case "$port_case" in
      producer-precreated-file)
        if [[ -f "$gateway_port_file" && ! -L "$gateway_port_file" \
          && "$(<"$gateway_port_file")" == "18789" ]]; then
          : >"$precreated_preserved_file"
        fi
        ;;
      producer-precreated-symlink)
        if [[ -L "$gateway_port_file" \
          && "$(readlink "$gateway_port_file")" == "$safe_runtime/preexisting-target" \
          && "$(<"$safe_runtime/preexisting-target")" == "18789" ]]; then
          : >"$precreated_preserved_file"
        fi
        ;;
      producer-precreated-directory)
        if [[ -d "$gateway_port_file" && ! -L "$gateway_port_file" ]]; then
          : >"$precreated_preserved_file"
        fi
        ;;
    esac
    find "$safe_runtime" -maxdepth 1 -name '.gateway-port.*' -print \
      >"$temp_residue_file" 2>/dev/null || true
    rm -rf -- "$safe_runtime"
  fi
  : >"$cleanup_file"
}
trap cleanup_runtime EXIT INT TERM

export CLAIM_FILE_FIXTURE="$claim_file"
cat >"$fake_bin/stat" <<'EOF'
#!/bin/bash
if [[ "$1" == "-c" && "$2" == "%u" && "$3" == "$CLAIM_FILE_FIXTURE" ]]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod 0755 "$fake_bin/stat"

cat >"$fake_bin/docker" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>'$docker_calls'
case "\$1" in
  exec)
    exit 0
    ;;
  stop | kill)
    : >'$action_file'
    exit 0
    ;;
  *)
    exit 91
    ;;
esac
EOF
chmod 0755 "$fake_bin/docker"

if [[ "$port_case" == "producer-failure" ]]; then
  cat >"$fake_bin/chown" <<'EOF'
#!/bin/bash
exit 93
EOF
  chmod 0755 "$fake_bin/chown"
fi

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

port_functions="$(awk '
  /^require_port\(\) \{/ { capture=1 }
  /^require_positive_integer\(\) \{/ { capture=0 }
  capture { print }
' "$wrapper")"
claim_functions="$(awk '
  /^runtime_claim_path\(\) \{/ { capture=1 }
  /^container_security_args=\(/ { capture=0 }
  capture { print }
' "$wrapper")"
gateway_boundary_function="$(awk '
  /^require_gateway_action_boundary_ready\(\) \{/ { capture=1 }
  capture && /^# The probe must reach/ { exit }
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

eval "$port_functions"
eval "$claim_functions"
eval "$gateway_boundary_function"

readonly docker_bin="$fake_bin/docker"
readonly flock_bin=/bin/true
readonly gateway_probe_script='process.exit(0)'

require_cleanup_timeout_parent() { :; }
require_container_name() { :; }
require_positive_integer() { :; }
require_readiness_timeout() { :; }
locked_runtime_root() { printf '%s\n' "$safe_runtime"; }
open_lifecycle_lock() {
  exec 9>"$safe_runtime/lifecycle-control.lock"
  printf -v "$2" '%s' 9
}
require_container_continuity() { :; }

initial_state='{"containerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":1,"mockContainerId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","phase":"ready","proxyContainerId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'

run_lifecycle_controller() {
  local operation="$1"
  shift
  printf '%s %s\n' "$operation" "$*" >>"$controller_calls"
  case "$operation" in
    status)
      if [[ -e "$action_file" ]]; then
        local ready_request_id
        ready_request_id="$(<"$request_file")"
        printf '{"causedByRequestId":"%s","containerId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","generation":2,"mockContainerId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","phase":"ready","proxyContainerId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","schemaVersion":1,"sequence":9}\n' \
          "$ready_request_id"
      else
        printf '%s\n' "$initial_state"
      fi
      ;;
    request)
      printf '%s\n' "$5" >"$request_file"
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

write_raw_port() {
  printf '%b' "$1" >"$gateway_port_file"
  chown root:root "$gateway_port_file"
  chmod 0400 "$gateway_port_file"
}

case "$port_case" in
  valid)
    write_root_port_file "$safe_runtime" 18789
    ;;
  valid-low)
    write_root_port_file "$safe_runtime" 1
    ;;
  valid-high)
    write_root_port_file "$safe_runtime" 65535
    ;;
  missing)
    ;;
  symlink)
    write_raw_port '18789\n'
    mv "$gateway_port_file" "$safe_runtime/preexisting-target"
    ln -s "$safe_runtime/preexisting-target" "$gateway_port_file"
    ;;
  directory)
    mkdir "$gateway_port_file"
    ;;
  wrong-owner)
    printf '18789\n' >"$gateway_port_file"
    chmod 0400 "$gateway_port_file"
    if [[ "$(id -u)" == "0" ]]; then
      chown 1:1 "$gateway_port_file"
    fi
    ;;
  wrong-mode)
    write_root_port_file "$safe_runtime" 18789
    chmod 0600 "$gateway_port_file"
    ;;
  hardlink)
    write_root_port_file "$safe_runtime" 18789
    ln "$gateway_port_file" "$output_root/gateway-port-link"
    ;;
  empty)
    write_raw_port ''
    ;;
  multiline)
    write_raw_port '18789\n2\n'
    ;;
  no-lf)
    write_raw_port '18789'
    ;;
  zero)
    write_raw_port '0\n'
    ;;
  overflow)
    write_raw_port '65536\n'
    ;;
  too-long)
    write_raw_port '12345678901234567890\n'
    ;;
  leading-zero)
    write_raw_port '01\n'
    ;;
  producer-precreated-file)
    write_raw_port '18789\n'
    write_root_port_file "$safe_runtime" 18789
    ;;
  producer-precreated-symlink)
    write_raw_port '18789\n'
    mv "$gateway_port_file" "$safe_runtime/preexisting-target"
    ln -s "$safe_runtime/preexisting-target" "$gateway_port_file"
    write_root_port_file "$safe_runtime" 18789
    ;;
  producer-precreated-directory)
    mkdir "$gateway_port_file"
    write_root_port_file "$safe_runtime" 18789
    ;;
  producer-failure)
    write_root_port_file "$safe_runtime" 18789
    ;;
  *)
    die "unknown port test case"
    ;;
esac

if [[ -f "$gateway_port_file" && ! -L "$gateway_port_file" ]]; then
  /usr/bin/stat -c '%u %a %h %s' "$gateway_port_file" >"$output_root/port-metadata"
fi

read_process_identity $$
printf '%s\t%s\t%s\t%s\n' \
  "$runtime_source_fixture" "$$" "$process_pgid" "$process_start" >"$claim_file"
chmod 0400 "$claim_file"

set -- "$container_name" "$runtime_source_fixture" 1 graceful 5
eval "$lifecycle_body"
