#!/usr/bin/env bash
set -euo pipefail
umask 077

helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="$1"
cli_entry="$2"
image="$3"
for executable in podman newuidmap newgidmap; do
  if ! command -v "$executable" >/dev/null; then
    printf '{"control":"podman","attempted":false,"missingExecutable":"%s"}\n' "$executable"
    exit 78
  fi
done
uid="$(id -u)"
gid="$(id -g)"
if [[ "${GITHUB_ACTIONS:-}" != true || -f /.dockerenv || "$uid" == 0 || ! -d "/run/user/$uid" ]]; then
  echo '{"control":"podman","attempted":false,"missingCapability":"disposable-host-nonroot-user-runtime"}'
  exit 78
fi

control_root="$(mktemp -d /tmp/openclaw-fleet-podman.XXXXXX)"
runtime_root="$(mktemp -d "/run/user/$uid/openclaw-fleet.XXXXXX")"
case_dir="$control_root/cell"
engine_root="$control_root/engine"
tenant="fleet-cache-podman-${control_root##*.}"
tenant="${tenant,,}"
container="openclaw-cell-$tenant"
network="$container-net"
initialization_attempted=false
private_store_verified=false
cell_attempted=false
interrupted=false
mkdir -p "$case_dir/home" "$case_dir/state" "$case_dir/host-cache" \
  "$engine_root/config" "$engine_root/data"

cat > "$engine_root/containers.conf" <<CONFIG
[engine]
static_dir = "$engine_root/data/containers/storage/libpod"
tmp_dir = "$runtime_root/libpod/tmp"
volume_path = "$engine_root/data/containers/storage/volumes"
CONFIG
runtime_env=(env -i PATH="$PATH" HOME="$case_dir/home" OPENCLAW_HOME="$case_dir/home" \
  OPENCLAW_STATE_DIR="$case_dir/state" XDG_CACHE_HOME="$case_dir/host-cache" \
  XDG_CONFIG_HOME="$engine_root/config" XDG_DATA_HOME="$engine_root/data" \
  XDG_RUNTIME_DIR="$runtime_root" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  CONTAINERS_STORAGE_CONF="$engine_root/storage.conf" CONTAINERS_CONF="$engine_root/containers.conf")

runtime() { timeout --foreground --kill-after=10s 180s "${runtime_env[@]}" podman "$@"; }
fleet() { timeout --foreground --kill-after=10s 180s "${runtime_env[@]}" "$node_bin" "$cli_entry" fleet "$@"; }

capture() {
  fleet status "$tenant" --json
  fleet logs "$tenant"
}

cleanup() {
  local result=$?
  local cleanup_result=0
  trap - EXIT
  printf '{"control":"podman","cleanupStarted":true,"originalExitCode":%s}\n' "$result"
  if [[ "$cell_attempted" == true ]]; then
    local registered=""
    if fleet list --json > "$control_root/cleanup-cells.json" && \
      registered="$(jq --arg tenant "$tenant" 'any(.cells[]; .tenant == $tenant)' "$control_root/cleanup-cells.json")"; then
      printf '{"control":"podman","registryEntryPresentBeforeCleanup":%s}\n' "$registered"
      if [[ "$registered" == true ]]; then
        if (( result != 0 )) && [[ "$interrupted" == false ]]; then
          capture || echo 'Fleet Podman failure diagnostics were incomplete.' >&2
        fi
        fleet rm "$tenant" --force --purge-data || cleanup_result=1
      fi
    else
      echo 'Fleet Podman registry inspection failed during cleanup.' >&2
      cleanup_result=1
    fi
    local exists_result=0
    runtime container exists "$container" || exists_result=$?
    printf '{"control":"podman","containerExistsExitCode":%s}\n' "$exists_result"
    [[ "$exists_result" == 1 ]] || cleanup_result=1
    exists_result=0
    runtime network exists "$network" || exists_result=$?
    printf '{"control":"podman","networkExistsExitCode":%s}\n' "$exists_result"
    [[ "$exists_result" == 1 ]] || cleanup_result=1
  fi
  if [[ "$initialization_attempted" == true && "$private_store_verified" == false ]]; then
    echo 'Fleet Podman private store was not verified; runtime cleanup requires owner inspection.' >&2
    cleanup_result=1
  fi
  if [[ "$private_store_verified" == true ]]; then
    local pause_pid=""
    if [[ -f "$runtime_root/libpod/tmp/pause.pid" ]]; then
      pause_pid="$(cat "$runtime_root/libpod/tmp/pause.pid")"
    fi
    runtime system migrate || cleanup_result=1
    local deadline=$((SECONDS + 10))
    while [[ -n "$pause_pid" && -e "/proc/$pause_pid" && "$SECONDS" -lt "$deadline" ]]; do
      sleep 0.1
    done
    if [[ -n "$pause_pid" && -e "/proc/$pause_pid" ]]; then
      echo 'Fleet Podman namespace process did not exit.' >&2
      cleanup_result=1
    fi
  fi
  if (( cleanup_result != 0 )); then
    printf '{"control":"podman","cleanupCompleted":false,"originalExitCode":%s}\n' "$result"
    printf 'Fleet Podman retained scratch: %s\nFleet Podman retained runtime: %s\n' "$control_root" "$runtime_root" >&2
    exit 1
  fi
  "$node_bin" --input-type=module - "$control_root" "$runtime_root" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
for (const directory of process.argv.slice(2)) {
  assert.equal(mounts.includes(directory), false, 'Podman scratch still has mounted filesystems');
}
JS
  sudo -n rm -rf -- "$control_root" "$runtime_root"
  [[ ! -e "$control_root" && ! -e "$runtime_root" ]]
  printf '{"control":"podman","cleanupCompleted":true,"originalExitCode":%s}\n' "$result"
  exit "$result"
}
trap cleanup EXIT
trap 'interrupted=true; exit 130' INT
trap 'interrupted=true; exit 143' TERM

check_cell() {
  local stage="$1"
  local port
  local status=""
  port="$(runtime port "$container" 18789/tcp)"
  [[ "$port" == 127.0.0.1:* ]]
  local deadline=$((SECONDS + 60))
  until status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 1 "http://$port/healthz")" && [[ "$status" == 200 ]]; do
    if (( SECONDS >= deadline )); then
      echo "Fleet Podman health timed out during $stage." >&2
      return 1
    fi
    sleep 1
  done
  printf '{"control":"podman","stage":"%s","healthStatus":%s}\n' "$stage" "$status"
  capture
  runtime container inspect "$container" | "$node_bin" "$helper_dir/assert-podman-cell.mjs" \
    "$case_dir/state" "$tenant" "$image" "$uid" "$gid" "$control_root/image.json"
  runtime exec -i "$container" node --input-type=module - "$uid" "$gid" < "$helper_dir/probe-podman-cell.mjs"
}

"$node_bin" "$helper_dir/prepare-podman-storage.mjs" "$cli_entry" "$engine_root" "$runtime_root"
printf '%s\n' '{"control":"podman","attempted":true}'
initialization_attempted=true
runtime info --format json > "$control_root/info.json"
"$node_bin" --input-type=module - "$control_root/info.json" "$engine_root" "$runtime_root" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [filename, engine, runtime] = process.argv.slice(2);
const info = JSON.parse(fs.readFileSync(filename, 'utf8'));
assert.equal(info.host.serviceIsRemote, false);
assert.equal(info.host.security.rootless, true);
assert.equal(info.host.cgroupVersion, 'v2');
assert.equal(info.host.cgroupManager, 'systemd');
assert.equal(info.host.security.seccompEnabled, true);
assert.equal(info.store.graphRoot, `${engine}/data/containers/storage`);
assert.equal(info.store.runRoot, `${runtime}/containers`);
assert.equal(info.store.volumePath, `${engine}/data/containers/storage/volumes`);
console.log(JSON.stringify({control: 'podman', version: info.version.Version,
  rootless: info.host.security.rootless, serviceIsRemote: info.host.serviceIsRemote,
  cgroupVersion: info.host.cgroupVersion, cgroupManager: info.host.cgroupManager,
  storageDriver: info.store.graphDriverName}));
JS
private_store_verified=true
"$node_bin" "$helper_dir/prepare-podman-storage.mjs" "$cli_entry" "$engine_root" "$runtime_root" "$control_root/info.json"
timeout --foreground --kill-after=10s 600s "${runtime_env[@]}" podman pull "$image"
runtime image inspect "$image" > "$control_root/image.json"
cell_attempted=true
fleet create "$tenant" --runtime podman --image "$image" \
  --gateway-token fleet-cache-synthetic-token --json > "$control_root/create.json"
check_cell create
fleet upgrade "$tenant" --image "$image" > "$control_root/upgrade.txt"
check_cell upgrade
fleet stop "$tenant"
fleet backup "$tenant" --out "$case_dir/backup.tgz" --json > "$control_root/backup.json"
fleet restore "$tenant" --from "$case_dir/backup.tgz" --json > "$control_root/restore.json"
jq -e '.started == false' "$control_root/restore.json" >/dev/null
runtime container inspect "$container" | jq -e '.[0].State.Running == false'
fleet start "$tenant"
check_cell stopped-restore
fleet restore "$tenant" --from "$case_dir/backup.tgz" --force --json > "$control_root/restore.json"
jq -e '.started == true' "$control_root/restore.json" >/dev/null
check_cell forced-restore
