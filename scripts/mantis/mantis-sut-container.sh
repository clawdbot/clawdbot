#!/bin/bash
set -euo pipefail

readonly image="node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
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

require_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "invalid positive integer"
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

process_start_time() {
  local stat_text
  stat_text="$(<"/proc/$1/stat")" || return 1
  local after_comm="${stat_text##*) }"
  local fields
  read -r -a fields <<<"$after_comm"
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${fields[19]}"
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
  [[ -r "/proc/$claimed_pid/stat" ]] || return 1
  [[ "$(process_start_time "$claimed_pid")" == "$claimed_start" ]] || return 1
  local current_pgid
  current_pgid="$(/usr/bin/ps -o pgid= -p "$claimed_pid" | tr -d ' ')"
  [[ "$current_pgid" == "$claimed_pgid" ]]
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
  local pgid
  pgid="$(/usr/bin/ps -o pgid= -p $$ | tr -d ' ')"
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || die "invalid runtime process group"
  local start_time
  start_time="$(process_start_time $$)" || die "could not read runtime process identity"
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
  [[ "$(stat -c %a "$worktree_root")" == "700" ]] || die "worktree root mode mismatch"
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
  chown root:root "$safe_runtime"
  chmod 0755 "$safe_runtime"
  if ! ln -s "$safe_runtime" "$runtime_source"; then
    destroy_bounded_filesystem "$safe_runtime" "$image_path"
    die "failed to publish locked runtime root"
  fi
  printf '%s\n' "$safe_runtime"
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
  cleanup() {
    rm -rf "$store"
  }
  trap cleanup EXIT INT TERM
  corepack pnpm install --frozen-lockfile --store-dir "$store"
  corepack pnpm build
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
  mock_pid=""
  gateway_pid=""
  cleanup() {
    exit_code=$?
    trap - EXIT INT TERM
    if [ -n "$gateway_pid" ]; then kill "$gateway_pid" 2>/dev/null || true; fi
    if [ -n "$mock_pid" ]; then kill "$mock_pid" 2>/dev/null || true; fi
    wait 2>/dev/null || true
    exit "$exit_code"
  }
  trap cleanup EXIT INT TERM
  node /opt/mantis/mock-openai-server.mjs >"$MOCK_LOG" 2>&1 &
  mock_pid=$!
  attempt=0
  until grep -q "mock-openai listening" "$MOCK_LOG" 2>/dev/null; do
    kill -0 "$mock_pid" 2>/dev/null || exit 1
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || exit 1
    sleep 0.1
  done
  node openclaw.mjs gateway --port "$OPENCLAW_GATEWAY_PORT" >"$GATEWAY_LOG" 2>&1 &
  gateway_pid=$!
  wait "$gateway_pid"
'

command="${1:-}"
shift || true
case "$command" in
  build)
    [[ "${SUDO_USER:-}" == "runner" ]] || die "build is restricted to the workflow runner"
    [[ $# -eq 1 ]] || die "build expects the candidate worktree"
    worktree_root="$(realpath -e "$(<"$worktree_root_file")")"
    candidate_root="$(realpath -e "$1")"
    [[ "$candidate_root" == "$worktree_root/candidate" ]] || die "unexpected candidate worktree"
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
    create_bounded_filesystem "${container_name}-fs" 10G >/dev/null
    isolated_root="$build_mount/repo"
    mkdir "$isolated_root"
    /bin/cp -a "$candidate_root/." "$isolated_root/"
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
    [[ -f "$response_control" && ! -L "$response_control" ]] || die "invalid mock response control"
    [[ "$(stat -c %u "$response_control")" == "$(id -u mantis-sut)" ]] \
      || die "mock response control owner mismatch"
    [[ "$(stat -c %a "$response_control")" == "600" ]] \
      || die "mock response control mode mismatch"
    [[ "$(stat -c %h "$response_control")" == "1" ]] \
      || die "mock response control must not be hard-linked"
    for name in gateway.log mock-openai.log mock-openai-requests.ndjson sut-attestation.json; do
      [[ ! -e "$safe_runtime/$name" && ! -L "$safe_runtime/$name" ]] \
        || die "runtime output was pre-created"
    done
    write_root_attestation "$safe_runtime/sut-attestation.json" "$lane" "$attested_sha"
    runtime_parent="$(realpath -e "$(<"$runtime_root_file")")"
    write_root_attestation "$runtime_parent/attestations/$lane.json" "$lane" "$attested_sha"
    success_marker="$(jq -er '.mockResponseText | strings' "$input_file")"
    telegram_bot_token="$(jq -er '.telegramBotToken | strings' "$input_file")"
    telegram_bot_id="${telegram_bot_token%%:*}"
    [[ "$telegram_bot_id" =~ ^[1-9][0-9]*$ ]] || die "invalid Telegram bot token"
    telegram_alias_token="${telegram_bot_id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    export SUCCESS_MARKER="$success_marker"
    export TELEGRAM_BOT_TOKEN="$telegram_alias_token"
    mock_response_chunk_delay_ms="$(jq -r '.mockResponseChunkDelayMs // ""' "$input_file")"
    gateway_password="$(jq -r '.gatewayPassword // ""' "$input_file")"
    rm -f "$input_file"
    trap - EXIT

    gateway_log="$runtime_source/gateway.log"
    mock_log="$runtime_source/mock-openai.log"
    request_log="$runtime_source/mock-openai-requests.ndjson"
    install -T -o mantis-sut -g mantis-proof -m 0600 /dev/null "$safe_runtime/gateway.log"
    install -T -o mantis-sut -g mantis-proof -m 0600 /dev/null "$safe_runtime/mock-openai.log"
    install -T -o mantis-sut -g mantis-proof -m 0600 /dev/null "$safe_runtime/mock-openai-requests.ndjson"
    export CI=1
    export GATEWAY_LOG="$gateway_log"
    export GIT_COMMIT="$attested_sha"
    export HOME="$runtime_source/container-home"
    export MOCK_LOG="$mock_log"
    export MOCK_PORT="$mock_port"
    export MOCK_REQUEST_LOG="$request_log"
    export MOCK_RESPONSE_CONTROL="$runtime_source/mock-control/response.json"
    export NODE_DISABLE_COMPILE_CACHE=1
    export OPENAI_API_KEY=sk-openclaw-e2e-mock
    export OPENCLAW_BUILD_PRIVATE_QA=1
    export OPENCLAW_CONFIG_PATH="$runtime_source/openclaw.json"
    export OPENCLAW_ENABLE_PRIVATE_QA_CLI=1
    export OPENCLAW_GATEWAY_PORT="$gateway_port"
    export OPENCLAW_STATE_DIR="$runtime_source/state"
    if [[ -n "$mock_response_chunk_delay_ms" ]]; then
      require_positive_integer "$mock_response_chunk_delay_ms"
      export MOCK_RESPONSE_CHUNK_DELAY_MS="$mock_response_chunk_delay_ms"
    fi
    if [[ -n "$gateway_password" ]]; then
      export OPENCLAW_GATEWAY_PASSWORD="$gateway_password"
    fi

    forwarded_env=(
      CI GATEWAY_LOG GIT_COMMIT HOME MOCK_LOG MOCK_PORT MOCK_REQUEST_LOG MOCK_RESPONSE_CONTROL NODE_DISABLE_COMPILE_CACHE
      OPENAI_API_KEY OPENCLAW_BUILD_PRIVATE_QA OPENCLAW_CONFIG_PATH
      OPENCLAW_ENABLE_PRIVATE_QA_CLI OPENCLAW_GATEWAY_PORT OPENCLAW_STATE_DIR
      SUCCESS_MARKER TELEGRAM_BOT_TOKEN
    )
    [[ -z "${MOCK_RESPONSE_CHUNK_DELAY_MS:-}" ]] || forwarded_env+=(MOCK_RESPONSE_CHUNK_DELAY_MS)
    [[ -z "${OPENCLAW_GATEWAY_PASSWORD:-}" ]] || forwarded_env+=(OPENCLAW_GATEWAY_PASSWORD)
    docker_env=()
    for name in "${forwarded_env[@]}"; do
      docker_env+=(--env "$name")
    done

    network_name="${container_name}-net"
    egress_network_name="${container_name}-egress"
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
      --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
      --env TELEGRAM_PROXY_ALIAS_TOKEN="$telegram_alias_token" \
      --env TELEGRAM_PROXY_UPSTREAM_TOKEN="$telegram_bot_token" \
      "$image" node /opt/mantis/telegram-bot-api-proxy.mjs >/dev/null
    "$docker_bin" network connect --alias telegram-api-proxy "$network_name" "$proxy_container_name"
    require_runtime_claim_active "$container_name"
    "$docker_bin" run --rm --init --name "$container_name" --network "$network_name" \
      "${container_security_args[@]}" "${runtime_resource_args[@]}" \
      --mount "type=bind,src=$repo_root,dst=$repo_root,readonly" \
      --mount "type=bind,src=$mock_server_script,dst=/opt/mantis/mock-openai-server.mjs,readonly" \
      --mount "type=bind,src=$safe_runtime,dst=$runtime_source" \
      --workdir "$repo_root" \
      --user "$(id -u mantis-sut):$(id -g mantis-sut)" \
      "${docker_env[@]}" \
      "$image" sh -c "$sut_command"
    remove_container_or_fail "$proxy_container_name"
    cleanup_network "$network_name"
    cleanup_network "$egress_network_name"
    trap - EXIT INT TERM
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
    # Signal the owner before deadline-exposed removal, then wait for its exact claim to end;
    # destroy follows stop synchronously and must not race the owner's TERM cleanup.
    terminate_runtime_claim
    stop_result=0
    remove_container_or_fail "$1" || stop_result=1
    remove_container_or_fail "${1}-telegram-proxy" || stop_result=1
    cleanup_network "${1}-net" || stop_result=1
    cleanup_network "${1}-egress" || stop_result=1
    wait_for_runtime_claim_exit
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
  *) die "expected build, check, run, stop, or destroy" ;;
esac
