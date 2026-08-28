#!/bin/bash
set -euo pipefail

readonly image="node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
readonly worktree_root_file="/etc/openclaw-mantis-sut-worktrees"
readonly revisions_file="/etc/openclaw-mantis-sut-revisions"
readonly runtime_root_file="/etc/openclaw-mantis-sut-runtime-root"
readonly docker_bin="/usr/bin/docker"
readonly flock_bin="/usr/bin/flock"
readonly iptables_bin="/usr/sbin/iptables"
readonly timeout_bin="/usr/bin/timeout"
readonly network_lock_file="/run/lock/openclaw-mantis-sut-network.lock"
readonly network_state_root="/run/openclaw-mantis-sut-networks"
readonly mock_server_script="/usr/local/lib/mantis-toolchain/scripts/e2e/mock-openai-server.mjs"
readonly telegram_proxy_script="/usr/local/lib/mantis-toolchain/scripts/e2e/telegram-bot-api-proxy.mjs"
readonly lifecycle_controller="/usr/local/lib/mantis-toolchain/scripts/mantis/mantis-sut-lifecycle-controller.mjs"
readonly lifecycle_node="/usr/local/lib/mantis-toolchain/node"

die() {
  echo "mantis SUT container: $*" >&2
  exit 64
}

run_cleanup_with_deadline() {
  local action="$1"
  shift
  # timeout owns a separate process group, so escalation reaches Docker and
  # network-cleanup descendants instead of killing only the caller's sudo.
  exec "$timeout_bin" --signal=TERM --kill-after=5s 30s /bin/bash "$0" "__${action}" "$@"
}

run_lifecycle_with_deadline() {
  [[ $# -eq 5 ]] || die "lifecycle expects a container name, runtime root, generation, mode, and readiness timeout"
  require_readiness_timeout "$5"
  # Budget graceful stop (10s), successor discovery (10s), requested readiness,
  # and 5s of bounded scheduling/cleanup slack.
  local deadline_seconds=$((10#$5 + 25))
  exec "$timeout_bin" --signal=TERM --kill-after=5s "${deadline_seconds}s" \
    /bin/bash "$0" __lifecycle "$@"
}

require_cleanup_timeout_parent() {
  [[ "$(readlink -f "/proc/$PPID/exe")" == "$timeout_bin" ]] \
    || die "internal cleanup action requires the timeout supervisor"
}

require_container_name() {
  [[ "$1" =~ ^openclaw-telegram-sut-[0-9a-f-]+$ ]] || die "invalid container name"
}

require_port() {
  if [[ ! "$1" =~ ^[0-9]+$ ]] || ((10#$1 < 1 || 10#$1 > 65535)); then
    die "invalid port"
  fi
}

write_root_port_file() {
  local safe_runtime="$1"
  local port="$2"
  require_port "$port"
  [[ "$port" == "$((10#$port))" ]] || die "invalid non-canonical port"
  local destination="$safe_runtime/gateway-port"
  [[ ! -e "$destination" && ! -L "$destination" ]] \
    || die "runtime gateway port already exists"
  local temp=""
  temp="$(mktemp -p "$safe_runtime" .gateway-port.XXXXXX)" \
    || die "failed to create runtime gateway port"
  if ! printf '%s\n' "$port" >"$temp" \
    || ! chown root:root "$temp" \
    || ! chmod 0400 "$temp"; then
    rm -f -- "$temp"
    die "failed to prepare runtime gateway port"
  fi
  if [[ ! -f "$temp" || -L "$temp" \
    || "$(/usr/bin/stat -c %u "$temp")" != "0" \
    || "$(/usr/bin/stat -c %a "$temp")" != "400" \
    || "$(/usr/bin/stat -c %h "$temp")" != "1" ]]; then
    rm -f -- "$temp"
    die "invalid prepared runtime gateway port"
  fi
  if ! mv -T "$temp" "$destination"; then
    rm -f -- "$temp"
    die "failed to publish runtime gateway port"
  fi
}

read_port_file() {
  local safe_runtime="$1"
  local port_file="$safe_runtime/gateway-port"
  [[ -f "$port_file" && ! -L "$port_file" ]] \
    || die "missing or invalid runtime gateway port"
  local port_fd
  exec {port_fd}<"$port_file" || die "could not open runtime gateway port"
  local path_identity
  local descriptor_identity
  path_identity="$(/usr/bin/stat -c '%d:%i' "$port_file")"
  descriptor_identity="$(/usr/bin/stat -Lc '%d:%i' "/proc/self/fd/$port_fd")"
  [[ "$path_identity" == "$descriptor_identity" ]] \
    || die "runtime gateway port identity changed"
  [[ -f "/proc/self/fd/$port_fd" ]] \
    || die "runtime gateway port is not a regular file"
  [[ "$(/usr/bin/stat -Lc %u "/proc/self/fd/$port_fd")" == "0" ]] \
    || die "runtime gateway port owner mismatch"
  [[ "$(/usr/bin/stat -Lc %a "/proc/self/fd/$port_fd")" == "400" ]] \
    || die "runtime gateway port mode mismatch"
  [[ "$(/usr/bin/stat -Lc %h "/proc/self/fd/$port_fd")" == "1" ]] \
    || die "runtime gateway port must not be hard-linked"
  local port_size
  port_size="$(/usr/bin/stat -Lc %s "/proc/self/fd/$port_fd")"
  [[ "$port_size" =~ ^[0-9]+$ ]] && ((10#$port_size >= 2 && 10#$port_size <= 6)) \
    || die "invalid runtime gateway port contents"
  local port
  IFS= read -r port <&"$port_fd" || die "invalid runtime gateway port contents"
  require_port "$port"
  [[ "$port" == "$((10#$port))" ]] || die "invalid non-canonical port"
  [[ "$port_size" == "$(( ${#port} + 1 ))" ]] \
    || die "invalid runtime gateway port contents"
  [[ -f "$port_file" && ! -L "$port_file" \
    && "$(/usr/bin/stat -c '%d:%i' "$port_file")" == "$descriptor_identity" ]] \
    || die "runtime gateway port identity changed"
  exec {port_fd}<&-
  printf '%s\n' "$port"
}

require_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "invalid positive integer"
}

require_readiness_timeout() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "invalid readiness timeout"
  ((10#$1 >= 5 && 10#$1 <= 120)) || die "invalid readiness timeout"
}

require_lifecycle_controller() {
  for file in "$lifecycle_node" "$lifecycle_controller"; do
    [[ -f "$file" && ! -L "$file" ]] || die "missing trusted lifecycle controller"
    [[ "$(stat -c %u "$file")" == "0" ]] || die "lifecycle controller owner mismatch"
    [[ -z "$(find "$file" -perm /022 -print -quit)" ]] \
      || die "lifecycle controller is writable"
  done
}

run_lifecycle_controller() {
  require_lifecycle_controller
  local command="$1"
  local safe_runtime="$2"
  shift 2
  local lock_path="$safe_runtime/lifecycle-transition.lock"
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "missing lifecycle transition lock"
  [[ "$(stat -c %u "$lock_path")" == "0" ]] || die "lifecycle transition lock owner mismatch"
  [[ "$(stat -c %a "$lock_path")" == "600" ]] \
    || die "lifecycle transition lock mode mismatch"
  [[ "$(stat -c %h "$lock_path")" == "1" ]] \
    || die "lifecycle transition lock must not be hard-linked"
  local transition_lock_fd
  exec {transition_lock_fd}>"$lock_path"
  "$flock_bin" -w 5 "$transition_lock_fd" || die "timed out serializing lifecycle evidence"
  local result=0
  "$lifecycle_node" "$lifecycle_controller" "$command" "$safe_runtime" "$@" || result=$?
  exec {transition_lock_fd}>&-
  return "$result"
}

runtime_parent_path() {
  realpath -e "$(<"$runtime_root_file")"
}

runtime_claim_path() {
  printf '%s/claims/%s.claim\n' "$(runtime_parent_path)" "$1"
}

runtime_cancel_path() {
  printf '%s/claims/%s.cancelled\n' "$(runtime_parent_path)" "$1"
}

read_process_identity() {
  local stat_text
  if ! { IFS= read -r stat_text <"/proc/$1/stat"; } 2>/dev/null; then
    return 1
  fi
  local after_comm="${stat_text##*) }"
  local fields
  read -r -a fields <<<"$after_comm"
  [[ "${fields[0]:-}" =~ ^[A-Za-z]$ ]] || return 1
  [[ "${fields[2]:-}" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  process_state="${fields[0]}"
  process_pgid="${fields[2]}"
  process_start="${fields[19]}"
}

process_start_time() {
  read_process_identity "$1" || return 1
  printf '%s\n' "$process_start"
}

read_runtime_claim() {
  local claim_path
  claim_path="$(runtime_claim_path "$1")"
  [[ -f "$claim_path" && ! -L "$claim_path" ]] || return 1
  [[ "$(stat -c %u "$claim_path")" == "0" ]] || return 1
  [[ "$(stat -c %a "$claim_path")" == "400" ]] || return 1
  [[ "$(stat -c %h "$claim_path")" == "1" ]] || return 1
  IFS=$'\t' read -r claimed_runtime claimed_pid claimed_pgid claimed_start <"$claim_path"
  [[ "$claimed_runtime" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] || return 1
  [[ "$claimed_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$claimed_pgid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$claimed_start" =~ ^[1-9][0-9]*$ ]] || return 1
}

claim_process_is_active() {
  read_process_identity "$claimed_pid" || return 1
  case "$process_state" in
    Z | X | x) return 1 ;;
  esac
  [[ "$process_start" == "$claimed_start" && "$process_pgid" == "$claimed_pgid" ]]
}

create_runtime_claim() {
  local container_name="$1"
  local runtime_source="$2"
  local runtime_parent
  runtime_parent="$(runtime_parent_path)"
  local claim_root="$runtime_parent/claims"
  install -d -o root -g root -m 0700 "$claim_root"
  local claim_path="$claim_root/$container_name.claim"
  local cancel_path="$claim_root/$container_name.cancelled"
  [[ ! -e "$claim_path" && ! -L "$claim_path" && ! -e "$cancel_path" && ! -L "$cancel_path" ]] \
    || die "runtime claim already exists"
  read_process_identity $$ || die "could not read runtime process identity"
  case "$process_state" in
    Z | X | x) die "runtime claim owner is not live" ;;
  esac
  local pgid="$process_pgid"
  local start_time="$process_start"
  local temp
  temp="$(mktemp -p "$claim_root" .claim.XXXXXX)"
  printf '%s\t%s\t%s\t%s\n' "$runtime_source" "$$" "$pgid" "$start_time" >"$temp"
  chmod 0400 "$temp"
  mv -T "$temp" "$claim_path"
}

cancel_runtime_claim() {
  local container_name="$1"
  local runtime_source="$2"
  read_runtime_claim "$container_name" || die "missing or invalid runtime claim"
  [[ "$claimed_runtime" == "$runtime_source" ]] || die "runtime claim path mismatch"
  local cancel_path
  cancel_path="$(runtime_cancel_path "$container_name")"
  if [[ ! -e "$cancel_path" && ! -L "$cancel_path" ]]; then
    install -o root -g root -m 0400 /dev/null "$cancel_path"
  fi
}

terminate_runtime_claim() {
  # Uses the tuple cancel_runtime_claim captured; never reread the claim by name here,
  # or delayed cleanup targets whatever replacement claim now holds the container name.
  if claim_process_is_active; then
    kill -TERM -- "-$claimed_pgid" 2>/dev/null || true
  fi
}

wait_for_runtime_claim_exit() {
  while claim_process_is_active; do
    /bin/sleep 0.1
  done
}

require_runtime_claim_active() {
  [[ ! -e "$(runtime_cancel_path "$1")" && ! -L "$(runtime_cancel_path "$1")" ]] \
    || die "runtime startup was cancelled"
}

exact_runtime_claim_is_active() {
  local container_name="$1"
  local expected_runtime="$2"
  local expected_pid="$3"
  local expected_pgid="$4"
  local expected_start="$5"
  if ! read_runtime_claim "$container_name"; then
    echo "mantis SUT container: runtime claim is missing or invalid" >&2
    return 1
  fi
  if [[ "$claimed_runtime" != "$expected_runtime" \
    || "$claimed_pid" != "$expected_pid" \
    || "$claimed_pgid" != "$expected_pgid" \
    || "$claimed_start" != "$expected_start" ]]; then
    echo "mantis SUT container: runtime claim identity changed" >&2
    return 1
  fi
  if ! claim_process_is_active; then
    echo "mantis SUT container: runtime claim owner is not active" >&2
    return 1
  fi
  if [[ -e "$(runtime_cancel_path "$container_name")" \
    || -L "$(runtime_cancel_path "$container_name")" ]]; then
    echo "mantis SUT container: runtime claim was cancelled" >&2
    return 1
  fi
}

require_exact_runtime_claim_active() {
  exact_runtime_claim_is_active "$@" || die "runtime claim authority was lost"
}

record_pending_lifecycle_request_failure() {
  local safe_runtime="$1"
  local request_id="$2"
  local lifecycle_state
  lifecycle_state="$(run_lifecycle_controller status "$safe_runtime")" || return 1
  local phase
  local active_request_id
  phase="$(jq -er '.phase' <<<"$lifecycle_state")" || return 1
  active_request_id="$(jq -r '.activeRequest.id // ""' <<<"$lifecycle_state")" || return 1
  [[ "$phase" == "restart-requested" && "$active_request_id" == "$request_id" ]] || return 2
  run_lifecycle_controller request-failed "$safe_runtime" "$request_id" >/dev/null
}

container_security_args=(
  --read-only
  --cap-drop ALL
  --log-driver none
  --security-opt no-new-privileges
  --pids-limit 512
  --sysctl net.ipv6.conf.all.disable_ipv6=1
  --tmpfs "/tmp:rw,nosuid,nodev,size=536870912"
)

build_resource_args=(
  --cpus 4
  --memory 16g
  --memory-swap 16g
)

runtime_resource_args=(
  --cpus 4
  --memory 8g
  --memory-swap 8g
)

proxy_resource_args=(
  --cpus 1
  --memory 256m
  --memory-swap 256m
)

blocked_networks=(
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  127.0.0.0/8
  169.254.0.0/16
  172.16.0.0/12
  192.168.0.0/16
  198.18.0.0/15
  224.0.0.0/4
  240.0.0.0/4
)

network_subnet() {
  "$docker_bin" network inspect "$1" --format '{{(index .IPAM.Config 0).Subnet}}'
}

network_exists() {
  local network_name="$1"
  local names
  if ! names="$("$docker_bin" network ls --format '{{.Name}}')"; then
    return 2
  fi
  grep -Fxq "$network_name" <<<"$names" && return 0
  return 1
}

network_state_path() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+$ ]] || die "invalid proof network name"
  printf '%s/%s.subnet\n' "$network_state_root" "$1"
}

write_network_state() {
  local network_name="$1"
  local subnet="$2"
  local state_path
  state_path="$(network_state_path "$network_name")"
  install -d -o root -g root -m 0700 "$network_state_root"
  local temp
  temp="$(mktemp -p "$network_state_root" .subnet.XXXXXX)"
  printf '%s\n' "$subnet" >"$temp"
  chmod 0400 "$temp"
  mv -T "$temp" "$state_path"
}

remove_iptables_rule() {
  while true; do
    if "$iptables_bin" -C "$@" 2>/dev/null; then
      if ! "$iptables_bin" -D "$@"; then
        if "$iptables_bin" -C "$@" 2>/dev/null; then
          return 1
        else
          local recheck_result=$?
          ((recheck_result == 1)) && return 0
          return "$recheck_result"
        fi
      fi
    else
      local result=$?
      ((result == 1)) && return 0
      return "$result"
    fi
  done
}

with_network_lock() {
  local operation="$1"
  shift
  local lock_fd
  exec {lock_fd}>"$network_lock_file"
  "$flock_bin" "$lock_fd"
  local result=0
  "$operation" "$@" || result=$?
  exec {lock_fd}>&-
  return "$result"
}

cleanup_network_unlocked() {
  local network_name="$1"
  local state_path
  state_path="$(network_state_path "$network_name")"
  local subnet=""
  if [[ -e "$state_path" || -L "$state_path" ]]; then
    [[ -f "$state_path" && ! -L "$state_path" ]] || return 1
    [[ "$(stat -c %u "$state_path")" == "0" ]] || return 1
    [[ "$(stat -c %a "$state_path")" == "400" ]] || return 1
    subnet="$(<"$state_path")"
    [[ "$subnet" =~ ^[0-9.]+/[0-9]+$ ]] || return 1
  fi
  local exists_result
  if network_exists "$network_name"; then
    exists_result=0
  else
    exists_result=$?
  fi
  if ((exists_result == 1)); then
    [[ -n "$subnet" ]] || return 0
  elif ((exists_result != 0)); then
    return "$exists_result"
  fi
  if ((exists_result == 0)); then
    local inspected_subnet
    inspected_subnet="$(network_subnet "$network_name")" || return 1
    [[ "$inspected_subnet" =~ ^[0-9.]+/[0-9]+$ ]] || return 1
    [[ -z "$subnet" || "$subnet" == "$inspected_subnet" ]] || return 1
    subnet="$inspected_subnet"
    write_network_state "$network_name" "$subnet" || return 1
    if ! "$docker_bin" network rm "$network_name" >/dev/null; then
      if network_exists "$network_name"; then
        return 1
      else
        exists_result=$?
        ((exists_result == 1)) || return "$exists_result"
      fi
    fi
  fi
  remove_iptables_rule INPUT -s "$subnet" -j REJECT || return 1
  for destination in "${blocked_networks[@]}"; do
    remove_iptables_rule DOCKER-USER -s "$subnet" -d "$destination" -j REJECT || return 1
  done
  rm -f "$state_path"
}

cleanup_network() {
  with_network_lock cleanup_network_unlocked "$1"
}

container_exists() {
  local container_name="$1"
  local names
  if ! names="$("$docker_bin" container ls --all --format '{{.Names}}')"; then
    return 2
  fi
  grep -Fxq "$container_name" <<<"$names" && return 0
  return 1
}

remove_container_or_fail() {
  local container_name="$1"
  local exists_result
  if container_exists "$container_name"; then
    exists_result=0
  else
    exists_result=$?
  fi
  if ((exists_result == 0)); then
    if ! "$docker_bin" rm --force "$container_name" >/dev/null; then
      if container_exists "$container_name"; then
        return 1
      else
        exists_result=$?
        ((exists_result == 1)) || return "$exists_result"
      fi
    fi
  elif ((exists_result != 1)); then
    return "$exists_result"
  fi
  if container_exists "$container_name"; then
    die "candidate container is still running"
  else
    exists_result=$?
    ((exists_result == 1)) || return "$exists_result"
  fi
}

wait_for_mock_openai() {
  local container_name="$1"
  local log_path="$2"
  local attempt=0
  until grep -q "mock-openai listening" "$log_path" 2>/dev/null; do
    if [[ "$("$docker_bin" inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" != "true" ]]; then
      tail -n 20 "$log_path" >&2 || true
      die "mock OpenAI container exited before readiness"
    fi
    attempt=$((attempt + 1))
    if ((attempt >= 100)); then
      tail -n 20 "$log_path" >&2 || true
      die "mock OpenAI container did not become ready within 10 seconds"
    fi
    /bin/sleep 0.1
  done
}

create_bounded_filesystem() {
  local name="$1"
  local size="$2"
  local runtime_parent
  runtime_parent="$(realpath -e "$(<"$runtime_root_file")")"
  local image_path="$runtime_parent/$name.ext4"
  local mount_path="$runtime_parent/$name"
  [[ ! -e "$image_path" && ! -e "$mount_path" ]] || die "bounded filesystem already exists"
  /usr/bin/truncate -s "$size" "$image_path"
  if ! /usr/sbin/mkfs.ext4 -q -F "$image_path"; then
    rm -f "$image_path"
    return 1
  fi
  if ! mkdir "$mount_path"; then
    rm -f "$image_path"
    return 1
  fi
  if ! /usr/bin/mount -o loop,nodev,nosuid "$image_path" "$mount_path"; then
    rmdir "$mount_path"
    rm -f "$image_path"
    return 1
  fi
  printf '%s\t%s\n' "$mount_path" "$image_path"
}

destroy_bounded_filesystem() {
  local mount_path="$1"
  local image_path="$2"
  if /usr/bin/mountpoint -q "$mount_path"; then
    /usr/bin/umount "$mount_path"
  fi
  rm -rf --one-file-system "$mount_path"
  rm -f "$image_path"
}

remove_claimed_runtime_input() {
  local input_path="$1"
  local runtime_parent="$2"
  if [[ -L "$input_path" ]]; then
    rm -f "$input_path"
    return
  fi
  [[ -e "$input_path" ]] || return 0
  [[ -d "$input_path" ]] || die "claimed runtime input is not a directory"
  [[ "$(stat -c %u "$input_path")" == "$(id -u mantis-sut)" ]] \
    || die "claimed runtime input owner mismatch"
  [[ "$(stat -c %d "$input_path")" == "$(stat -c %d "$runtime_parent")" ]] \
    || die "claimed runtime input filesystem mismatch"
  rm -rf --one-file-system "$input_path"
  [[ ! -e "$input_path" && ! -L "$input_path" ]] || die "failed to remove claimed runtime input"
}

create_public_only_network_unlocked() {
  local network_name="$1"
  cleanup_network_unlocked "$network_name" || return 1
  if ! "$docker_bin" network create --driver bridge \
    --opt com.docker.network.bridge.enable_icc=false "$network_name" >/dev/null; then
    return 1
  fi
  local subnet
  if ! subnet="$(network_subnet "$network_name")"; then
    cleanup_network_unlocked "$network_name" || true
    return 1
  fi
  if [[ ! "$subnet" =~ ^[0-9.]+/[0-9]+$ ]]; then
    cleanup_network_unlocked "$network_name" || true
    return 1
  fi
  if ! write_network_state "$network_name" "$subnet"; then
    cleanup_network_unlocked "$network_name" || true
    return 1
  fi
  if ! "$iptables_bin" -I INPUT 1 -s "$subnet" -j REJECT; then
    cleanup_network_unlocked "$network_name" || true
    return 1
  fi
  for destination in "${blocked_networks[@]}"; do
    if ! "$iptables_bin" -I DOCKER-USER 1 -s "$subnet" -d "$destination" -j REJECT; then
      cleanup_network_unlocked "$network_name" || true
      return 1
    fi
  done
}

create_public_only_network() {
  with_network_lock create_public_only_network_unlocked "$1"
}

create_internal_network_unlocked() {
  local network_name="$1"
  cleanup_network_unlocked "$network_name" || return 1
  if ! "$docker_bin" network create --driver bridge --internal "$network_name" >/dev/null; then
    return 1
  fi
  local subnet
  if ! subnet="$(network_subnet "$network_name")"; then
    cleanup_network_unlocked "$network_name" || true
    return 1
  fi
  [[ "$subnet" =~ ^[0-9.]+/[0-9]+$ ]] || return 1
  write_network_state "$network_name" "$subnet"
}

create_internal_network() {
  with_network_lock create_internal_network_unlocked "$1"
}

require_locked_worktree() {
  local repo_root="$1"
  local lane="$2"
  local worktree_root
  worktree_root="$(realpath -e "$(<"$worktree_root_file")")"
  [[ "$(stat -c %u "$worktree_root")" == "0" ]] || die "worktree root is not root-owned"
  [[ "$lane" == "baseline" || "$lane" == "candidate" ]] || die "invalid proof lane"
  [[ "$repo_root" == "$worktree_root/$lane" ]] || die "repo root does not match the proof lane"
  [[ "$(stat -c %u "$repo_root")" == "0" ]] || die "prepared worktree is not root-owned"
  [[ -z "$(find "$repo_root" -xdev ! -type l -perm /222 -print -quit)" ]] \
    || die "prepared worktree is writable"
}

expected_sha_for_lane() {
  local lane="$1"
  local expected_sha
  expected_sha="$(awk -v lane="$lane" '$1 == lane { print $2 }' "$revisions_file")"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || die "invalid configured proof revision"
  printf '%s\n' "$expected_sha"
}

attest_worktree() {
  local repo_root="$1"
  local lane="$2"
  local expected_sha
  expected_sha="$(expected_sha_for_lane "$lane")"
  local actual_sha
  actual_sha="$(/usr/bin/git -c safe.directory="$repo_root" -C "$repo_root" rev-parse HEAD)"
  [[ "$actual_sha" == "$expected_sha" ]] || die "prepared worktree revision mismatch"
  printf '%s\n' "$actual_sha"
}

write_root_attestation() {
  local destination="$1"
  local lane="$2"
  local sha="$3"
  if [[ -e "$destination" || -L "$destination" ]]; then
    jq -e --arg lane "$lane" --arg sha "$sha" \
      '.lane == $lane and .sha == $sha' "$destination" >/dev/null \
      || die "conflicting SUT attestation"
    return
  fi
  local temp
  temp="$(mktemp -p "$(dirname "$destination")" .sut-attestation.XXXXXX)"
  jq -n --arg lane "$lane" --arg sha "$sha" '{lane: $lane, sha: $sha}' >"$temp"
  chmod 0444 "$temp"
  mv -T "$temp" "$destination"
}

lock_runtime_root() {
  local runtime_source="$1"
  local container_name="$2"
  [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
    || die "invalid runtime root"
  [[ -d "$runtime_source" && ! -L "$runtime_source" ]] || die "runtime root is not a directory"
  [[ "$(stat -c %u "$runtime_source")" == "$(id -u mantis-sut)" ]] || die "runtime root owner mismatch"
  local runtime_parent
  runtime_parent="$(realpath -e "$(<"$runtime_root_file")")"
  [[ "$(stat -c %u "$runtime_parent")" == "0" ]] || die "runtime parent is not root-owned"
  [[ "$(stat -c %a "$runtime_parent")" == "711" ]] || die "runtime parent mode mismatch"
  [[ "$(stat -c %d "$runtime_source")" == "$(stat -c %d "$runtime_parent")" ]] \
    || die "runtime input and quarantine must share a filesystem"
  local quarantine="$runtime_parent/$container_name-input"
  [[ ! -e "$quarantine" && ! -L "$quarantine" ]] || die "runtime quarantine already exists"
  mv -T "$runtime_source" "$quarantine"
  if [[ ! -d "$quarantine" || -L "$quarantine" ]]; then
    rm -f "$quarantine"
    die "quarantined runtime is not a directory"
  fi
  if [[ "$(stat -c %u "$quarantine")" != "$(id -u mantis-sut)" ]]; then
    rm -rf --one-file-system "$quarantine"
    die "quarantined runtime owner mismatch"
  fi
  local filesystem
  if ! filesystem="$(create_bounded_filesystem "$container_name" 2G)"; then
    rm -rf --one-file-system "$quarantine"
    die "failed to create the bounded runtime filesystem"
  fi
  local safe_runtime="${filesystem%%$'\t'*}"
  local image_path="${filesystem#*$'\t'}"
  chown mantis-sut:mantis-proof "$safe_runtime"
  chmod 0700 "$safe_runtime"
  if ! /usr/sbin/runuser -u mantis-sut -- \
    /bin/cp -a --no-dereference "$quarantine/." "$safe_runtime/"; then
    destroy_bounded_filesystem "$safe_runtime" "$image_path"
    rm -rf --one-file-system "$quarantine"
    die "failed to stage the bounded runtime root"
  fi
  if ! rm -rf --one-file-system "$quarantine"; then
    destroy_bounded_filesystem "$safe_runtime" "$image_path"
    die "failed to remove the quarantined runtime input"
  fi
  chown root:mantis-proof "$safe_runtime"
  # The agent may stage developer files at runtime; sticky ownership keeps
  # root-owned attestation files from being replaced or removed.
  chmod 1770 "$safe_runtime"
  if ! ln -s "$safe_runtime" "$runtime_source"; then
    destroy_bounded_filesystem "$safe_runtime" "$image_path"
    die "failed to publish locked runtime root"
  fi
  printf '%s\n' "$safe_runtime"
}

locked_runtime_root() {
  local runtime_source="$1"
  local container_name="$2"
  local runtime_parent
  runtime_parent="$(runtime_parent_path)"
  local expected="$runtime_parent/$container_name"
  [[ -L "$runtime_source" && "$(readlink "$runtime_source")" == "$expected" ]] \
    || die "runtime is not locked to the claimed container"
  local resolved
  resolved="$(realpath -e "$runtime_source")"
  [[ "$resolved" == "$expected" ]] || die "locked runtime target mismatch"
  [[ -d "$resolved" && ! -L "$resolved" ]] || die "locked runtime is not a directory"
  [[ "$(stat -c %u "$resolved")" == "0" ]] || die "locked runtime owner mismatch"
  [[ "$(stat -c %a "$resolved")" == "1770" ]] || die "locked runtime mode mismatch"
  printf '%s\n' "$resolved"
}

create_lifecycle_lock() {
  local safe_runtime="$1"
  local name
  for name in lifecycle-control.lock lifecycle-transition.lock; do
    local lock_path="$safe_runtime/$name"
    [[ ! -e "$lock_path" && ! -L "$lock_path" ]] || die "lifecycle lock already exists"
    install -o root -g root -m 0600 /dev/null "$lock_path"
  done
}

open_lifecycle_lock() {
  local safe_runtime="$1"
  local output_variable="$2"
  local lock_path="$safe_runtime/lifecycle-control.lock"
  [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "missing lifecycle lock"
  [[ "$(stat -c %u "$lock_path")" == "0" ]] || die "lifecycle lock owner mismatch"
  [[ "$(stat -c %a "$lock_path")" == "600" ]] || die "lifecycle lock mode mismatch"
  [[ "$(stat -c %h "$lock_path")" == "1" ]] || die "lifecycle lock must not be hard-linked"
  local descriptor
  exec {descriptor}>"$lock_path"
  printf -v "$output_variable" '%s' "$descriptor"
}

runtime_claim_is_cancelled() {
  [[ -e "$(runtime_cancel_path "$1")" || -L "$(runtime_cancel_path "$1")" ]]
}

wait_for_gateway_container() {
  local container_name="$1"
  local docker_pid="$2"
  local deadline=$((SECONDS + 10))
  local container_id=""
  while ((SECONDS < deadline)); do
    runtime_claim_is_cancelled "$container_name" && return 2
    container_id="$($docker_bin inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)"
    if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$container_id"
      return 0
    fi
    kill -0 "$docker_pid" 2>/dev/null || return 1
    /bin/sleep 0.1
  done
  return 1
}

wait_for_gateway_ready() {
  local container_name="$1"
  local container_id="$2"
  local docker_pid="$3"
  local gateway_log="$4"
  local log_offset="$5"
  local timeout_seconds="$6"
  local gateway_port="$7"
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    runtime_claim_is_cancelled "$container_name" && return 2
    local observed_id
    observed_id="$($docker_bin inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)"
    [[ -z "$observed_id" || "$observed_id" == "$container_id" ]] \
      || die "gateway container identity changed during readiness"
    if tail -c "+$((log_offset + 1))" "$gateway_log" 2>/dev/null \
      | grep -Fq '[gateway] ready'; then
      observed_id="$($docker_bin inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)"
      if [[ "$observed_id" == "$container_id" ]] \
        && "$docker_bin" exec --env OPENCLAW_MANTIS_GATEWAY_PORT="$gateway_port" \
          "$container_id" node -e "$gateway_probe_script" >/dev/null 2>&1; then
        return 0
      fi
    fi
    kill -0 "$docker_pid" 2>/dev/null || return 1
    /bin/sleep 0.1
  done
  return 1
}

require_container_continuity() {
  local container_name="$1"
  local expected_container_id="$2"
  local label="$3"
  shift 3
  local actual_container_id
  local actual_running
  local networks_json
  actual_container_id="$($docker_bin inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)"
  if [[ "$actual_container_id" != "$expected_container_id" ]]; then
    echo "mantis SUT container: $label container identity changed" >&2
    return 1
  fi
  actual_running="$($docker_bin inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)"
  if [[ "$actual_running" != "true" ]]; then
    echo "mantis SUT container: $label container is not running" >&2
    return 1
  fi
  networks_json="$($docker_bin inspect --format '{{json .NetworkSettings.Networks}}' \
    "$container_name" 2>/dev/null || true)"
  if [[ -z "$networks_json" ]]; then
    echo "mantis SUT container: $label container networks are unavailable" >&2
    return 1
  fi
  if [[ "$(jq -er 'keys | length' <<<"$networks_json")" != "$#" ]]; then
    echo "mantis SUT container: $label container network attachments changed" >&2
    return 1
  fi
  local expected_network
  for expected_network in "$@"; do
    if ! jq -e --arg network "$expected_network" 'has($network)' \
      <<<"$networks_json" >/dev/null; then
      echo "mantis SUT container: $label container network attachments changed" >&2
      return 1
    fi
  done
}

require_gateway_action_boundary_ready() {
  local container_name="$1"
  local container_id="$2"
  local gateway_port="$3"
  local internal_network="$4"
  require_container_continuity "$container_name" "$container_id" "gateway lifecycle successor" \
    "$internal_network" || return 1
  "$docker_bin" exec --env OPENCLAW_MANTIS_GATEWAY_PORT="$gateway_port" \
    "$container_id" node -e "$gateway_probe_script" >/dev/null 2>&1 \
    || {
      echo "mantis SUT container: gateway lifecycle successor failed the action-boundary readiness probe" >&2
      return 1
    }
  require_container_continuity "$container_name" "$container_id" "gateway lifecycle successor" \
    "$internal_network"
}

# The probe must reach Telegram's public edge while every host/private/metadata
# target remains unreachable through the exact network used by candidate code.
# shellcheck disable=SC2016
readonly network_probe_script='
  const dns = require("node:dns").promises;
  const net = require("node:net");
  const connects = (host, port) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
  (async () => {
    // Port 9 need not be open: the INPUT reject counter below proves the host-bound
    // packet hit our isolation rule, while a closed port alone cannot satisfy the check.
    const blocked = await Promise.all([
      connects("runner-host", 9),
      connects("10.0.0.1", 80),
      connects("100.100.100.200", 80),
      connects("169.254.169.254", 80),
      connects("192.168.0.1", 80),
    ]);
    if (blocked.some(Boolean)) process.exit(41);
    const [telegramIp] = await dns.resolve4("api.telegram.org");
    if (!telegramIp || !(await connects(telegramIp, 443))) process.exit(42);
  })().catch((error) => { console.error(error); process.exit(42); });
'

# Candidate lifecycle scripts run only inside the isolated build container.
# shellcheck disable=SC2016
readonly build_command='
  set -eu
  store=.mantis-pnpm-store
  test -d "$store"
  test -n "$(find "$store" -type f -print -quit)"
  cleanup() {
    rm -rf "$store"
  }
  trap cleanup EXIT INT TERM
  corepack pnpm install --frozen-lockfile --store-dir "$store"
  OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 corepack pnpm build
'

run_network_probe() {
  local network_name="$1"
  "$docker_bin" run --rm --network "$network_name" "${container_security_args[@]}" \
    "${runtime_resource_args[@]}" \
    --add-host runner-host:host-gateway \
    "$image" node -e "$network_probe_script"
  local subnet
  subnet="$(network_subnet "$network_name")"
  local input_packets
  input_packets="$(
    "$iptables_bin" -L INPUT -v -n -x \
      | awk -v source="$subnet" '$3 == "REJECT" && $8 == source { total += $1 } END { print total + 0 }'
  )"
  ((input_packets > 0)) || die "host isolation rule did not observe the probe"
  local private_packets=0
  for destination in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 192.168.0.0/16; do
    local destination_packets
    destination_packets="$(
      "$iptables_bin" -L DOCKER-USER -v -n -x \
        | awk -v source="$subnet" -v destination="$destination" \
          '$3 == "REJECT" && $8 == source && $9 == destination { total += $1 } END { print total + 0 }'
    )"
    private_packets=$((private_packets + destination_packets))
  done
  ((private_packets > 0)) || die "private-network isolation rules did not observe the probe"
}

# The variables in this program are expanded inside the container, not here.
# shellcheck disable=SC2016
readonly sut_command='
  set -eu
  exec node openclaw.mjs gateway --port "$OPENCLAW_GATEWAY_PORT" >>"$GATEWAY_LOG" 2>&1
'

# Root invokes this fixed probe through Docker exec after the generation-specific
# ready marker. Candidate logs alone cannot attest that the exact container accepts traffic.
# shellcheck disable=SC2016
readonly gateway_probe_script='
  const net = require("node:net");
  const port = Number(process.env.OPENCLAW_MANTIS_GATEWAY_PORT);
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.on("connect", () => { socket.destroy(); process.exit(0); });
  socket.on("error", () => process.exit(1));
  socket.on("timeout", () => { socket.destroy(); process.exit(1); });
'

require_active_sut() {
  local container_name="$1"
  local runtime_source="$2"
  require_container_name "$container_name"
  [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
    || die "invalid runtime source"
  read_runtime_claim "$container_name" || die "missing or invalid runtime claim"
  [[ "$claimed_runtime" == "$runtime_source" ]] || die "runtime claim path mismatch"
  claim_process_is_active || die "runtime claim is not active"
  require_runtime_claim_active "$container_name"
}

command="${1:-}"
shift || true
case "$command" in
  build)
    [[ "${SUDO_USER:-}" == "runner" ]] || die "build is restricted to the workflow runner"
    [[ $# -eq 2 ]] || die "build expects the candidate worktree and host pnpm store"
    worktree_root="$(realpath -e "$(<"$worktree_root_file")")"
    candidate_root="$(realpath -e "$1")"
    host_pnpm_store="$(realpath -e "$2")"
    [[ "$candidate_root" == "$worktree_root/candidate" ]] || die "unexpected candidate worktree"
    [[ -d "$host_pnpm_store" ]] || die "host pnpm store is not a directory"
    [[ "$host_pnpm_store" != "$candidate_root" && "$host_pnpm_store" != "$candidate_root/"* ]] \
      || die "host pnpm store must be outside the candidate worktree"
    [[ "$(stat -c %u "$candidate_root")" == "$(id -u mantis-builder)" ]] || die "candidate owner mismatch"
    [[ -f "$candidate_root/.git" && ! -L "$candidate_root/.git" ]] \
      || die "candidate Git link is not a regular file"
    [[ "$(stat -c %h "$candidate_root/.git")" == "1" ]] \
      || die "candidate Git link must not be hard-linked"
    (("$(stat -c %s "$candidate_root/.git")" <= 4096)) || die "candidate Git link is too large"
    candidate_git_link="$(<"$candidate_root/.git")"
    [[ "$candidate_git_link" == "gitdir: "* ]] || die "candidate Git link is invalid"
    candidate_sha="$(attest_worktree "$candidate_root" candidate)"

    container_name="openclaw-mantis-build-$$"
    runtime_parent="$(realpath -e "$(<"$runtime_root_file")")"
    build_mount="$runtime_parent/${container_name}-fs"
    build_image="$runtime_parent/${container_name}-fs.ext4"
    network_name="${container_name}-net"
    published_root="$worktree_root/.candidate-built-$$"
    [[ ! -e "$published_root" && ! -L "$published_root" ]] \
      || die "candidate publish directory already exists"
    # shellcheck disable=SC2329
    cleanup_build() {
      local result=0
      remove_container_or_fail "$container_name" || result=$?
      cleanup_network "$network_name" || result=$?
      destroy_bounded_filesystem "$build_mount" "$build_image" || result=$?
      if [[ -n "${published_root:-}" && ( -e "$published_root" || -L "$published_root" ) ]]; then
        rm -rf --one-file-system "$published_root" || result=$?
      fi
      return "$result"
    }
    # `set -e` preserves a failed probe/container status through this EXIT trap.
    # The explicit cleanup below is reached only after the protected command succeeds.
    trap cleanup_build EXIT INT TERM
    # 16G bounds worktree + full pnpm-store copy + build output together; the image
    # is sparse so unused capacity costs nothing, and the post-build 8 GiB check
    # below still bounds what leaves the container.
    create_bounded_filesystem "${container_name}-fs" 16G >/dev/null
    isolated_root="$build_mount/repo"
    mkdir "$isolated_root"
    /bin/cp -a "$candidate_root/." "$isolated_root/"
    store_copy_start=$SECONDS
    mkdir "$isolated_root/.mantis-pnpm-store"
    # Host disk -> loop image crosses filesystems, so reflink falls back to a full
    # byte copy on CI; keep --reflink=auto for same-filesystem hosts. Never bind or
    # hard-link the host store: candidate lifecycle scripts may rewrite their store.
    /bin/cp -a --reflink=auto "$host_pnpm_store/." "$isolated_root/.mantis-pnpm-store/"
    test -n "$(find "$isolated_root/.mantis-pnpm-store" -type f -print -quit)"
    echo "Copied disposable pnpm store in $((SECONDS - store_copy_start))s."
    chown -R mantis-builder:mantis-builder "$isolated_root"
    create_public_only_network "$network_name"
    run_network_probe "$network_name"
    /usr/bin/timeout --signal=TERM --kill-after=30s 30m \
      "$docker_bin" run --rm --init --name "$container_name" --network "$network_name" \
      "${container_security_args[@]}" "${build_resource_args[@]}" \
      --mount "type=bind,src=$isolated_root,dst=$candidate_root" \
      --workdir "$candidate_root" \
      --user "$(id -u mantis-builder):$(id -g mantis-builder)" \
      --env CI=1 \
      --env COREPACK_HOME=/tmp/corepack \
      --env GIT_COMMIT="$candidate_sha" \
      --env HOME=/tmp/home \
      --env OPENCLAW_BUILD_PRIVATE_QA=1 \
      --env OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 \
      "$image" sh -c "$build_command"
    remove_container_or_fail "$container_name"
    cleanup_network "$network_name"
    build_size_mb="$(du -sm "$isolated_root" | awk '{print $1}')"
    ((build_size_mb <= 8192)) || die "candidate build output exceeds 8 GiB"
    [[ -f "$isolated_root/.git" && ! -L "$isolated_root/.git" ]] \
      || die "isolated Git link is not a regular file"
    [[ "$(stat -c %h "$isolated_root/.git")" == "1" ]] \
      || die "isolated Git link must not be hard-linked"
    (("$(stat -c %s "$isolated_root/.git")" <= 4096)) || die "isolated Git link is too large"
    [[ "$(<"$isolated_root/.git")" == "$candidate_git_link" ]] \
      || die "isolated Git link changed during build"
    mkdir -m 0755 "$published_root"
    /bin/cp -a --no-dereference "$isolated_root/." "$published_root/"
    [[ -f "$published_root/.git" && ! -L "$published_root/.git" ]] \
      || die "published Git link is not a regular file"
    [[ "$(<"$published_root/.git")" == "$candidate_git_link" ]] \
      || die "published Git link mismatch"
    rm -rf --one-file-system "$candidate_root"
    mv -T "$published_root" "$candidate_root"
    published_root=""
    destroy_bounded_filesystem "$build_mount" "$build_image"
    trap - EXIT INT TERM
    ;;
  check)
    [[ $# -eq 0 ]] || die "check expects no arguments"
    network_name="openclaw-mantis-check-$$"
    create_public_only_network "$network_name"
    # shellcheck disable=SC2329
    cleanup_check() {
      cleanup_network "$network_name"
    }
    trap cleanup_check EXIT INT TERM
    run_network_probe "$network_name"
    cleanup_network "$network_name"
    trap - EXIT INT TERM
    ;;
  run)
    [[ $# -eq 6 ]] \
      || die "run expects name, lane, repo root, runtime root, gateway port, and mock port"
    container_name="$1"
    lane="$2"
    repo_root="$(realpath -e "$3")"
    runtime_source="$4"
    gateway_port="$5"
    mock_port="$6"
    require_container_name "$container_name"
    require_port "$gateway_port"
    require_port "$mock_port"
    [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
      || die "invalid runtime root"
    create_runtime_claim "$container_name" "$runtime_source"

    require_locked_worktree "$repo_root" "$lane"
    attested_sha="$(attest_worktree "$repo_root" "$lane")"
    require_runtime_claim_active "$container_name"
    safe_runtime="$(lock_runtime_root "$runtime_source" "$container_name")"
    require_runtime_claim_active "$container_name"

    input_file="$safe_runtime/container-input.json"
    trap 'rm -f "${input_file:-}"' EXIT
    [[ -f "$input_file" && ! -L "$input_file" ]] || die "invalid container input"
    [[ "$(stat -c %u "$input_file")" == "$(id -u mantis-sut)" ]] || die "container input owner mismatch"
    [[ "$(stat -c %a "$input_file")" == "600" ]] || die "container input mode mismatch"
    [[ "$(stat -c %h "$input_file")" == "1" ]] || die "container input must not be hard-linked"
    response_control_dir="$safe_runtime/mock-control"
    [[ -d "$response_control_dir" && ! -L "$response_control_dir" ]] \
      || die "invalid mock response control directory"
    [[ "$(stat -c %u "$response_control_dir")" == "$(id -u mantis-sut)" ]] \
      || die "mock response control directory owner mismatch"
    [[ "$(stat -c %a "$response_control_dir")" == "700" ]] \
      || die "mock response control directory mode mismatch"
    response_control="$response_control_dir/response.json"
    request_log="$response_control_dir/mock-openai-requests.ndjson"
    mock_log="$response_control_dir/mock-openai.log"
    for file in "$response_control" "$request_log" "$mock_log"; do
      [[ -f "$file" && ! -L "$file" ]] || die "invalid mock control or evidence file"
      [[ "$(stat -c %u "$file")" == "$(id -u mantis-sut)" ]] \
        || die "mock control or evidence file owner mismatch"
      [[ "$(stat -c %a "$file")" == "600" ]] \
        || die "mock control or evidence file mode mismatch"
      [[ "$(stat -c %h "$file")" == "1" ]] \
        || die "mock control or evidence file must not be hard-linked"
    done
    proxy_control_dir="$safe_runtime/proxy-control"
    [[ -d "$proxy_control_dir" && ! -L "$proxy_control_dir" ]] \
      || die "invalid Telegram proxy control directory"
    [[ "$(stat -c %u "$proxy_control_dir")" == "$(id -u mantis-sut)" ]] \
      || die "Telegram proxy control directory owner mismatch"
    [[ "$(stat -c %a "$proxy_control_dir")" == "700" ]] \
      || die "Telegram proxy control directory mode mismatch"
    proxy_control="$proxy_control_dir/control.json"
    proxy_record="$proxy_control_dir/requests.ndjson"
    for file in "$proxy_control" "$proxy_record"; do
      [[ -f "$file" && ! -L "$file" ]] || die "invalid Telegram proxy control file"
      [[ "$(stat -c %u "$file")" == "$(id -u mantis-sut)" ]] \
        || die "Telegram proxy control file owner mismatch"
      [[ "$(stat -c %a "$file")" == "600" ]] \
        || die "Telegram proxy control file mode mismatch"
      [[ "$(stat -c %h "$file")" == "1" ]] \
        || die "Telegram proxy control file must not be hard-linked"
    done
    for name in gateway-port gateway.log lifecycle-control.lock lifecycle-events.ndjson \
      lifecycle-state.json lifecycle-transition.lock sut-attestation.json; do
      [[ ! -e "$safe_runtime/$name" && ! -L "$safe_runtime/$name" ]] \
        || die "runtime output was pre-created"
    done
    write_root_port_file "$safe_runtime" "$gateway_port"
    write_root_attestation "$safe_runtime/sut-attestation.json" "$lane" "$attested_sha"
    runtime_parent="$(realpath -e "$(<"$runtime_root_file")")"
    write_root_attestation "$runtime_parent/attestations/$lane.json" "$lane" "$attested_sha"
    success_marker="$(jq -er '.mockResponseText | strings' "$input_file")"
    telegram_bot_token="$(jq -er '.telegramBotToken | strings' "$input_file")"
    telegram_bot_id="${telegram_bot_token%%:*}"
    [[ "$telegram_bot_id" =~ ^[1-9][0-9]*$ ]] || die "invalid Telegram bot token"
    telegram_alias_token="${telegram_bot_id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    export TELEGRAM_BOT_TOKEN="$telegram_alias_token"
    mock_response_chunk_delay_ms="$(jq -r '.mockResponseChunkDelayMs // ""' "$input_file")"
    gateway_password="$(jq -r '.gatewayPassword // ""' "$input_file")"
    rm -f "$input_file"
    trap - EXIT

    gateway_log="$runtime_source/gateway.log"
    install -T -o mantis-sut -g mantis-proof -m 0600 /dev/null "$safe_runtime/gateway.log"
    create_lifecycle_lock "$safe_runtime"
    run_lifecycle_controller initialize "$safe_runtime" >/dev/null
    export CI=1
    export GATEWAY_LOG="$gateway_log"
    export GIT_COMMIT="$attested_sha"
    export HOME="$runtime_source/container-home"
    export NODE_DISABLE_COMPILE_CACHE=1
    export OPENAI_API_KEY=sk-openclaw-e2e-mock
    export OPENCLAW_BUILD_PRIVATE_QA=1
    export OPENCLAW_CONFIG_PATH="$runtime_source/openclaw.json"
    export OPENCLAW_ENABLE_PRIVATE_QA_CLI=1
    export OPENCLAW_GATEWAY_PORT="$gateway_port"
    export OPENCLAW_STATE_DIR="$runtime_source/state"
    if [[ -n "$mock_response_chunk_delay_ms" ]]; then
      require_positive_integer "$mock_response_chunk_delay_ms"
    fi
    if [[ -n "$gateway_password" ]]; then
      export OPENCLAW_GATEWAY_PASSWORD="$gateway_password"
    fi

    forwarded_env=(
      CI GATEWAY_LOG GIT_COMMIT HOME NODE_DISABLE_COMPILE_CACHE
      OPENAI_API_KEY OPENCLAW_BUILD_PRIVATE_QA OPENCLAW_CONFIG_PATH
      OPENCLAW_ENABLE_PRIVATE_QA_CLI OPENCLAW_GATEWAY_PORT OPENCLAW_STATE_DIR
      TELEGRAM_BOT_TOKEN
    )
    [[ -z "${OPENCLAW_GATEWAY_PASSWORD:-}" ]] || forwarded_env+=(OPENCLAW_GATEWAY_PASSWORD)
    docker_env=()
    for name in "${forwarded_env[@]}"; do
      docker_env+=(--env "$name")
    done

    network_name="${container_name}-net"
    egress_network_name="${container_name}-egress"
    mock_container_name="${container_name}-mock-openai"
    proxy_container_name="${container_name}-telegram-proxy"
    [[ -f "$telegram_proxy_script" && ! -L "$telegram_proxy_script" ]] \
      || die "missing trusted Telegram Bot API proxy"
    [[ "$(stat -c %u "$telegram_proxy_script")" == "0" ]] \
      || die "Telegram Bot API proxy owner mismatch"
    [[ -z "$(find "$telegram_proxy_script" -perm /222 -print -quit)" ]] \
      || die "Telegram Bot API proxy is writable"
    [[ -f "$mock_server_script" && ! -L "$mock_server_script" ]] \
      || die "missing trusted mock OpenAI server"
    [[ "$(stat -c %u "$mock_server_script")" == "0" ]] \
      || die "mock OpenAI server owner mismatch"
    [[ -z "$(find "$mock_server_script" -perm /222 -print -quit)" ]] \
      || die "mock OpenAI server is writable"
    # shellcheck disable=SC2329
    cleanup_run() {
      local result=0
      remove_container_or_fail "$container_name" || result=$?
      remove_container_or_fail "$mock_container_name" || result=$?
      remove_container_or_fail "$proxy_container_name" || result=$?
      cleanup_network "$network_name" || result=$?
      cleanup_network "$egress_network_name" || result=$?
      return "$result"
    }
    trap cleanup_run EXIT INT TERM
    create_internal_network "$network_name"
    create_public_only_network "$egress_network_name"
    run_network_probe "$egress_network_name"
    require_runtime_claim_active "$container_name"
    "$docker_bin" run --detach --name "$proxy_container_name" --network "$egress_network_name" \
      "${container_security_args[@]}" "${proxy_resource_args[@]}" \
      --mount "type=bind,src=$telegram_proxy_script,dst=/opt/mantis/telegram-bot-api-proxy.mjs,readonly" \
      --mount "type=bind,src=$proxy_control_dir,dst=/opt/mantis/proxy-control" \
      --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
      --env TELEGRAM_PROXY_ALIAS_TOKEN="$telegram_alias_token" \
      --env TELEGRAM_PROXY_CONTROL=/opt/mantis/proxy-control/control.json \
      --env TELEGRAM_PROXY_RECORD_FILE=/opt/mantis/proxy-control/requests.ndjson \
      --env TELEGRAM_PROXY_UPSTREAM_TOKEN="$telegram_bot_token" \
      "$image" node /opt/mantis/telegram-bot-api-proxy.mjs >/dev/null
    "$docker_bin" network connect --alias telegram-api-proxy "$network_name" "$proxy_container_name"
    require_runtime_claim_active "$container_name"
    mock_env=(
      --env MOCK_BIND_HOST=0.0.0.0
      --env MOCK_PORT="$mock_port"
      --env MOCK_REQUEST_LOG=/opt/mantis/mock-control/mock-openai-requests.ndjson
      --env MOCK_RESPONSE_CONTROL=/opt/mantis/mock-control/response.json
      --env SUCCESS_MARKER="$success_marker"
    )
    if [[ -n "$mock_response_chunk_delay_ms" ]]; then
      mock_env+=(--env MOCK_RESPONSE_CHUNK_DELAY_MS="$mock_response_chunk_delay_ms")
    fi
    "$docker_bin" run --detach --name "$mock_container_name" --network "$network_name" \
      --network-alias mock-openai \
      "${container_security_args[@]}" "${proxy_resource_args[@]}" \
      --mount "type=bind,src=$mock_server_script,dst=/opt/mantis/mock-openai-server.mjs,readonly" \
      --mount "type=bind,src=$response_control_dir,dst=/opt/mantis/mock-control" \
      --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
      "${mock_env[@]}" \
      "$image" sh -c 'exec node /opt/mantis/mock-openai-server.mjs >/opt/mantis/mock-control/mock-openai.log 2>&1' \
      >/dev/null
    wait_for_mock_openai "$mock_container_name" "$mock_log"
    mock_container_id="$($docker_bin inspect --format '{{.Id}}' "$mock_container_name")"
    proxy_container_id="$($docker_bin inspect --format '{{.Id}}' "$proxy_container_name")"
    [[ "$mock_container_id" =~ ^[0-9a-f]{64}$ \
      && "$proxy_container_id" =~ ^[0-9a-f]{64}$ \
      && "$mock_container_id" != "$proxy_container_id" ]] \
      || die "invalid Mantis sidecar identities"
    run_lifecycle_controller sidecars \
      "$safe_runtime" "$mock_container_id" "$proxy_container_id" >/dev/null
    require_runtime_claim_active "$container_name"
    # proxy-control holds the proxy's fault rules and recorded Bot API facts.
    # The SUT runs untrusted candidate code as the same mantis-sut UID, so an
    # inaccessible tmpfs must shadow the directory inside the runtime mount;
    # without it the lane under test could rewrite its own trusted evidence.
    # mock-control holds provider controls and evidence. Shadow it inside the SUT
    # so candidate code cannot read controls or forge provider evidence.
    generation=1
    readiness_timeout=60
    while true; do
      if runtime_claim_is_cancelled "$container_name"; then
        run_lifecycle_controller cancel "$safe_runtime" >/dev/null
        break
      fi
      gateway_log_offset="$(stat -c %s "$safe_runtime/gateway.log")"
      "$docker_bin" run --rm --init --name "$container_name" --network "$network_name" \
        "${container_security_args[@]}" "${runtime_resource_args[@]}" \
        --mount "type=bind,src=$repo_root,dst=$repo_root,readonly" \
        --mount "type=bind,src=$safe_runtime,dst=$runtime_source" \
        --mount "type=tmpfs,dst=$runtime_source/mock-control,tmpfs-size=65536,tmpfs-mode=0000" \
        --mount "type=tmpfs,dst=$runtime_source/proxy-control,tmpfs-size=65536,tmpfs-mode=0000" \
        --workdir "$repo_root" \
        --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
        "${docker_env[@]}" \
        "$image" sh -c "$sut_command" &
      gateway_docker_pid=$!
      gateway_start_result=0
      gateway_container_id="$(wait_for_gateway_container \
        "$container_name" "$gateway_docker_pid")" || gateway_start_result=$?
      if ((gateway_start_result != 0)); then
        if ((gateway_start_result == 2)); then
          remove_container_or_fail "$container_name" || true
          set +e
          wait "$gateway_docker_pid"
          set -e
          run_lifecycle_controller cancel "$safe_runtime" >/dev/null
          break
        fi
        set +e
        wait "$gateway_docker_pid"
        set -e
        run_lifecycle_controller start-failed "$safe_runtime" "$generation" >/dev/null
        die "gateway container did not start"
      fi
      run_lifecycle_controller started \
        "$safe_runtime" "$generation" "$gateway_container_id" >/dev/null
      gateway_ready_result=0
      wait_for_gateway_ready "$container_name" "$gateway_container_id" \
        "$gateway_docker_pid" "$gateway_log" "$gateway_log_offset" "$readiness_timeout" \
        "$gateway_port" || gateway_ready_result=$?
      if ((gateway_ready_result != 0)); then
        remove_container_or_fail "$container_name" || true
        set +e
        wait "$gateway_docker_pid"
        set -e
        if ((gateway_ready_result == 2)); then
          run_lifecycle_controller cancel "$safe_runtime" >/dev/null
          break
        fi
        run_lifecycle_controller readiness-failed \
          "$safe_runtime" "$generation" "$gateway_container_id" >/dev/null
        die "gateway generation $generation did not become ready within ${readiness_timeout}s"
      fi
      run_lifecycle_controller ready \
        "$safe_runtime" "$generation" "$gateway_container_id" >/dev/null

      set +e
      wait "$gateway_docker_pid"
      gateway_exit_code=$?
      set -e
      remove_container_or_fail "$container_name"
      if runtime_claim_is_cancelled "$container_name"; then
        run_lifecycle_controller cancel "$safe_runtime" >/dev/null
        break
      fi
      state_before_exit="$(run_lifecycle_controller status "$safe_runtime")"
      successor_state="$(run_lifecycle_controller exited \
        "$safe_runtime" "$generation" "$gateway_container_id" "$gateway_exit_code")"
      if [[ "$(jq -r '.phase' <<<"$successor_state")" != "starting" ]]; then
        die "gateway generation $generation exited without a lifecycle request"
      fi
      readiness_timeout="$(jq -er '.activeRequest.readinessTimeoutSeconds' \
        <<<"$state_before_exit")"
      require_readiness_timeout "$readiness_timeout"
      generation="$(jq -er '.generation' <<<"$successor_state")"
      require_positive_integer "$generation"
    done
    remove_container_or_fail "$mock_container_name"
    remove_container_or_fail "$proxy_container_name"
    cleanup_network "$network_name"
    cleanup_network "$egress_network_name"
    trap - EXIT INT TERM
    ;;
  exec)
    [[ $# -ge 4 ]] || die "exec expects a container name, runtime root, and shell command"
    container_name="$1"
    runtime_source="$2"
    shift 2
    timeout_seconds=120
    if [[ "${1:-}" == "--timeout-seconds" ]]; then
      [[ $# -ge 3 ]] || die "exec --timeout-seconds needs a value"
      timeout_seconds="$2"
      shift 2
    fi
    require_positive_integer "$timeout_seconds"
    ((timeout_seconds <= 1800)) || die "exec timeout exceeds 1800 seconds"
    [[ "${1:-}" == "--" ]] || die "exec shell command must follow --"
    shift
    [[ $# -eq 1 ]] || die "exec expects one shell command"
    require_active_sut "$container_name" "$runtime_source"
    "$docker_bin" exec \
      --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
      --workdir "$runtime_source" \
      "$container_name" \
      /usr/bin/timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" \
      sh -c "$1"
    ;;
  lifecycle)
    run_lifecycle_with_deadline "$@"
    ;;
  __lifecycle)
    require_cleanup_timeout_parent
    [[ $# -eq 5 ]] \
      || die "lifecycle expects a container name, runtime root, generation, mode, and readiness timeout"
    container_name="$1"
    runtime_source="$2"
    expected_generation="$3"
    lifecycle_mode="$4"
    readiness_timeout="$5"
    require_container_name "$container_name"
    [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
      || die "invalid runtime source"
    require_positive_integer "$expected_generation"
    [[ "$lifecycle_mode" == "graceful" || "$lifecycle_mode" == "crash" ]] \
      || die "invalid lifecycle mode"
    require_readiness_timeout "$readiness_timeout"
    read_runtime_claim "$container_name" || die "missing or invalid runtime claim"
    [[ "$claimed_runtime" == "$runtime_source" ]] || die "runtime claim path mismatch"
    claim_process_is_active || die "runtime claim is not active"
    require_runtime_claim_active "$container_name"
    safe_runtime="$(locked_runtime_root "$runtime_source" "$container_name")"
    open_lifecycle_lock "$safe_runtime" lifecycle_lock_fd
    "$flock_bin" "$lifecycle_lock_fd"
    # The generation and exact Docker identity are revalidated under the root-owned
    # lock. A delayed command can never target a replacement generation by name alone.
    read_runtime_claim "$container_name" || die "missing or invalid runtime claim"
    [[ "$claimed_runtime" == "$runtime_source" ]] || die "runtime claim path mismatch"
    claim_process_is_active || die "runtime claim is not active"
    require_runtime_claim_active "$container_name"
    lifecycle_claim_runtime="$claimed_runtime"
    lifecycle_claim_pid="$claimed_pid"
    lifecycle_claim_pgid="$claimed_pgid"
    lifecycle_claim_start="$claimed_start"
    lifecycle_state="$(run_lifecycle_controller status "$safe_runtime")"
    [[ "$(jq -er '.phase' <<<"$lifecycle_state")" == "ready" ]] \
      || die "gateway lifecycle action requires a ready generation"
    [[ "$(jq -er '.generation' <<<"$lifecycle_state")" == "$expected_generation" ]] \
      || die "stale gateway lifecycle generation"
    gateway_container_id="$(jq -er '.containerId' <<<"$lifecycle_state")"
    mock_container_id="$(jq -er '.mockContainerId' <<<"$lifecycle_state")"
    proxy_container_id="$(jq -er '.proxyContainerId' <<<"$lifecycle_state")"
    [[ "$gateway_container_id" =~ ^[0-9a-f]{64}$ ]] || die "invalid lifecycle container identity"
    internal_network="${container_name}-net"
    egress_network="${container_name}-egress"
    gateway_port="$(read_port_file "$safe_runtime")"
    require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
    require_gateway_action_boundary_ready "$container_name" "$gateway_container_id" \
      "$gateway_port" "$internal_network" \
      || die "gateway lifecycle generation failed pre-action continuity validation"
    require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
    require_container_continuity "${container_name}-mock-openai" "$mock_container_id" \
      "mock OpenAI sidecar" "$internal_network" \
      || die "mock OpenAI sidecar failed pre-action continuity validation"
    require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
    require_container_continuity "${container_name}-telegram-proxy" "$proxy_container_id" \
      "Telegram proxy sidecar" "$internal_network" "$egress_network" \
      || die "Telegram proxy sidecar failed pre-action continuity validation"
    require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
    request_id="$(</proc/sys/kernel/random/uuid)"
    require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
    run_lifecycle_controller request "$safe_runtime" "$expected_generation" \
      "$lifecycle_mode" "$readiness_timeout" "$request_id" >/dev/null
    # The root state machine now owns serialization: a second action sees phase=requested
    # and is rejected. Do not hold this lock across Docker I/O, because stop must be able
    # to publish cancellation and tear down an exact runtime even if Docker transport hangs.
    exec {lifecycle_lock_fd}>&-
    if ! exact_runtime_claim_is_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"; then
      request_failure_result=0
      record_pending_lifecycle_request_failure "$safe_runtime" "$request_id" \
        || request_failure_result=$?
      ((request_failure_result == 0 || request_failure_result == 2)) \
        || die "runtime claim authority was lost and request failure evidence could not be recorded"
      die "runtime claim authority was lost before the Docker lifecycle action"
    fi
    action_result=0
    if [[ "$lifecycle_mode" == "graceful" ]]; then
      "$docker_bin" stop --time 10 "$gateway_container_id" >/dev/null || action_result=$?
    else
      "$docker_bin" kill --signal KILL "$gateway_container_id" >/dev/null || action_result=$?
    fi
    if ! exact_runtime_claim_is_active "$container_name" "$lifecycle_claim_runtime" \
      "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"; then
      request_failure_result=0
      record_pending_lifecycle_request_failure "$safe_runtime" "$request_id" \
        || request_failure_result=$?
      ((request_failure_result == 0 || request_failure_result == 2)) \
        || die "runtime claim authority was lost and request failure evidence could not be recorded"
      die "runtime claim authority was lost after the Docker lifecycle action"
    fi
    if ((action_result != 0)); then
      current_container_id="$($docker_bin inspect --format '{{.Id}}' \
        "$gateway_container_id" 2>/dev/null || true)"
      current_running="$($docker_bin inspect --format '{{.State.Running}}' \
        "$gateway_container_id" 2>/dev/null || true)"
      if [[ "$current_container_id" == "$gateway_container_id" && "$current_running" == "true" ]]; then
        run_lifecycle_controller request-failed "$safe_runtime" "$request_id" >/dev/null
        die "failed to trigger $lifecycle_mode lifecycle action"
      fi
      # Docker may report a lost wait/transport after the exact container already exited.
      # The supervisor's root-owned generation state is authoritative from here.
    fi
    # The supervisor has a distinct bounded phase to discover the successor's
    # immutable Docker ID before applying the requested readiness budget.
    lifecycle_deadline=$((SECONDS + 10 + readiness_timeout))
    while ((SECONDS < lifecycle_deadline)); do
      require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
        "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
      lifecycle_state="$(run_lifecycle_controller status "$safe_runtime")"
      lifecycle_phase="$(jq -er '.phase' <<<"$lifecycle_state")"
      lifecycle_generation="$(jq -er '.generation' <<<"$lifecycle_state")"
      lifecycle_request_id="$(jq -r '.causedByRequestId // ""' <<<"$lifecycle_state")"
      if [[ "$lifecycle_phase" == "ready" \
        && "$lifecycle_generation" == "$((10#$expected_generation + 1))" \
        && "$lifecycle_request_id" == "$request_id" ]]; then
        successor_container_id="$(jq -er '.containerId' <<<"$lifecycle_state")"
        [[ "$successor_container_id" =~ ^[0-9a-f]{64}$ \
          && "$successor_container_id" != "$gateway_container_id" ]] \
          || die "gateway lifecycle successor identity is invalid"
        require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
          "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
        if ! require_gateway_action_boundary_ready "$container_name" "$successor_container_id" \
          "$gateway_port" "$internal_network"; then
          run_lifecycle_controller dependency-failed "$safe_runtime" "$request_id" gateway \
            >/dev/null
          die "gateway lifecycle successor failed action-boundary validation"
        fi
        require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
          "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
        if ! require_container_continuity "${container_name}-mock-openai" "$mock_container_id" \
          "mock OpenAI sidecar" "$internal_network"; then
          run_lifecycle_controller dependency-failed "$safe_runtime" "$request_id" mock-openai \
            >/dev/null
          die "mock OpenAI sidecar failed action-boundary validation"
        fi
        require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
          "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
        if ! require_container_continuity "${container_name}-telegram-proxy" \
          "$proxy_container_id" "Telegram proxy sidecar" "$internal_network" \
          "$egress_network"; then
          run_lifecycle_controller dependency-failed "$safe_runtime" "$request_id" \
            telegram-proxy >/dev/null
          die "Telegram proxy sidecar failed action-boundary validation"
        fi
        require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
          "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
        lifecycle_state="$(run_lifecycle_controller status "$safe_runtime")"
        [[ "$(jq -er '.phase' <<<"$lifecycle_state")" == "ready" \
          && "$(jq -er '.generation' <<<"$lifecycle_state")" == "$((10#$expected_generation + 1))" \
          && "$(jq -er '.causedByRequestId' <<<"$lifecycle_state")" == "$request_id" \
          && "$(jq -er '.containerId' <<<"$lifecycle_state")" == "$successor_container_id" ]] \
          || die "gateway lifecycle successor changed at the action boundary"
        require_exact_runtime_claim_active "$container_name" "$lifecycle_claim_runtime" \
          "$lifecycle_claim_pid" "$lifecycle_claim_pgid" "$lifecycle_claim_start"
        printf '%s\n' "$lifecycle_state"
        exit 0
      fi
      [[ "$lifecycle_phase" != "failed" && "$lifecycle_phase" != "cancelled" ]] \
        || die "gateway lifecycle replacement entered terminal phase $lifecycle_phase"
      /bin/sleep 0.1
    done
    die "gateway lifecycle replacement did not become ready within the bounded discovery and ${readiness_timeout}s readiness budget"
    ;;
  stop)
    run_cleanup_with_deadline stop "$@"
    ;;
  __stop)
    require_cleanup_timeout_parent
    [[ $# -eq 2 ]] || die "stop expects a container name and runtime root"
    require_container_name "$1"
    runtime_source="$2"
    [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
      || die "invalid runtime source"
    cancel_runtime_claim "$1" "$runtime_source"
    stop_result=0
    if [[ -L "$runtime_source" ]]; then
      safe_runtime="$(locked_runtime_root "$runtime_source" "$1")"
      if [[ -f "$safe_runtime/lifecycle-control.lock" \
        && -f "$safe_runtime/lifecycle-state.json" ]]; then
        # Evidence corruption must stay fail-loud, but it must not strand exact Docker
        # resources. Contain lock/controller exits in a subshell, finish cleanup, then
        # return a failure after every container, network, and owner has been handled.
        (
          open_lifecycle_lock "$safe_runtime" lifecycle_lock_fd
          "$flock_bin" -w 15 "$lifecycle_lock_fd" \
            || die "timed out waiting for lifecycle control to stop"
          # This subshell is the left operand of `||`, so Bash does not honor
          # errexit inside it. Propagate cancellation failure explicitly; the
          # outer handler records it and still completes exact-ID cleanup.
          run_lifecycle_controller cancel "$safe_runtime" >/dev/null || exit "$?"
          exec {lifecycle_lock_fd}>&-
        ) || stop_result=1
      fi
    fi
    # Signal the owner before deadline-exposed removal, then wait for its exact claim to end;
    # destroy follows stop synchronously and must not race the owner's TERM cleanup.
    terminate_runtime_claim
    remove_container_or_fail "$1" || stop_result=1
    remove_container_or_fail "${1}-mock-openai" || stop_result=1
    remove_container_or_fail "${1}-telegram-proxy" || stop_result=1
    cleanup_network "${1}-net" || stop_result=1
    cleanup_network "${1}-egress" || stop_result=1
    wait_for_runtime_claim_exit
    ((stop_result == 0)) \
      || echo "mantis SUT container: stop completed with lifecycle evidence or cleanup errors" >&2
    exit "$stop_result"
    ;;
  destroy)
    run_cleanup_with_deadline destroy "$@"
    ;;
  __destroy)
    require_cleanup_timeout_parent
    [[ $# -eq 2 ]] || die "destroy expects a container name and runtime root"
    require_container_name "$1"
    runtime_source="$2"
    [[ "$runtime_source" =~ ^/tmp/openclaw-tg-crabbox-sut-[A-Za-z0-9]+$ ]] \
      || die "invalid runtime source"
    read_runtime_claim "$1" || die "missing or invalid runtime claim"
    [[ "$claimed_runtime" == "$runtime_source" ]] || die "runtime claim path mismatch"
    claim_process_is_active && die "refusing to destroy an active runtime claim"
    runtime_parent="$(runtime_parent_path)"
    runtime_root="$runtime_parent/$1"
    if container_exists "$1"; then
      die "refusing to destroy a running SUT container"
    else
      exists_result=$?
      ((exists_result == 1)) || exit "$exists_result"
    fi
    if container_exists "${1}-telegram-proxy"; then
      die "refusing to destroy a running Telegram proxy container"
    else
      exists_result=$?
      ((exists_result == 1)) || exit "$exists_result"
    fi
    if container_exists "${1}-mock-openai"; then
      die "refusing to destroy a running mock OpenAI container"
    else
      exists_result=$?
      ((exists_result == 1)) || exit "$exists_result"
    fi
    for network_name in "${1}-net" "${1}-egress"; do
      if network_exists "$network_name"; then
        die "refusing to destroy an active SUT network"
      else
        exists_result=$?
        ((exists_result == 1)) || exit "$exists_result"
      fi
      network_state="$(network_state_path "$network_name")"
      [[ ! -e "$network_state" && ! -L "$network_state" ]] \
        || die "refusing to destroy runtime with pending network cleanup"
    done
    if [[ -L "$runtime_source" ]]; then
      [[ "$(readlink "$runtime_source")" == "$runtime_root" ]] \
        || die "invalid locked runtime symlink"
      rm -f "$runtime_source"
    else
      remove_claimed_runtime_input "$runtime_source" "$runtime_parent"
    fi
    remove_claimed_runtime_input "$runtime_parent/$1-input" "$runtime_parent"
    if [[ -e "$runtime_root" || -L "$runtime_root" || -e "$runtime_parent/$1.ext4" ]]; then
      destroy_bounded_filesystem "$runtime_root" "$runtime_parent/$1.ext4"
    fi
    rm -f "$(runtime_cancel_path "$1")" "$(runtime_claim_path "$1")"
    ;;
  *) die "expected build, check, run, exec, lifecycle, stop, or destroy" ;;
esac
