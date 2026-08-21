#!/usr/bin/env bash
set -euo pipefail

readonly SUT_USER="openclaw-sut"
readonly NODE_VERSION="24.15.0"
readonly NODE_SHA256="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6"
readonly PNPM_VERSION="11.15.1"
readonly OCM_VERSION="v0.2.32"
readonly OCM_SHA256="5b20c21b2825f69b89eb37baa657f0f0062124517e6e6828e9857c7e9bbd3070"
readonly CRABBOX_COMMIT="8ba71f913bbe57285ae29af45ef0d8ec6712477d"
readonly MAX_ARTIFACT_FILES=256
readonly MAX_ARTIFACT_BYTES=250000000
readonly MAX_ARTIFACT_FILE_BYTES=50000000
VERIFY_TMP=""

die() {
  printf 'openclaw-performance-crabbox: %s\n' "$*" >&2
  exit 1
}

require_sha() {
  [[ "$2" =~ ^[0-9a-f]{40}$ ]] || die "$1 must be a 40-character lowercase SHA"
}

require_scalar() {
  [[ -n "$2" && ${#2} -le 256 && "$2" != *$'\n'* && "$2" != *$'\r'* ]] ||
    die "$1 must be a single line of at most 256 characters"
}

file_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

as_sut() {
  local uid
  uid="$(id -u "$SUT_USER")"
  runuser -u "$SUT_USER" -- env -i \
    HOME="/home/${SUT_USER}" \
    XDG_CACHE_HOME="/home/${SUT_USER}/.cache" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    PATH="/home/${SUT_USER}/.local/bin:/opt/node-v${NODE_VERSION}/bin:/opt/ocm-${OCM_VERSION}:/usr/local/bin:/usr/bin:/bin" \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    CI=1 \
    OPENCLAW_SKIP_CHANNELS=1 \
    OPENCLAW_SKIP_CRON=1 \
    "$@"
}

clone_exact() {
  local repository="$1" sha="$2" destination="$3"
  install -d -m 0755 -o "$SUT_USER" -g "$SUT_USER" "$destination"
  as_sut git -C "$destination" init -b main
  as_sut git -C "$destination" remote add origin "https://github.com/${repository}.git"
  as_sut git -C "$destination" fetch --filter=blob:none --depth=1 origin "$sha"
  as_sut git -C "$destination" checkout --detach FETCH_HEAD
  [[ "$(as_sut git -C "$destination" rev-parse HEAD)" == "$sha" ]] ||
    die "${repository} checkout drifted"
  [[ "$(as_sut git -C "$destination" remote get-url origin)" == "https://github.com/${repository}.git" ]] ||
    die "${repository} origin changed"
}

install_toolchain() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git iptables jq procps sudo tar xz-utils >/dev/null

  local node_root="/opt/node-v${NODE_VERSION}" node_archive="/tmp/node.tar.xz"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 180 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    -o "$node_archive"
  echo "${NODE_SHA256}  ${node_archive}" | sha256sum -c -
  rm -rf "$node_root"
  mkdir -p "$node_root"
  tar -xJf "$node_archive" -C "$node_root" --strip-components=1
  [[ "$("$node_root/bin/node" --version)" == "v${NODE_VERSION}" ]] || die "Node version mismatch"

  local ocm_root="/opt/ocm-${OCM_VERSION}" ocm_archive="/tmp/ocm.tar.gz"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 180 \
    "https://github.com/shakkernerd/ocm/releases/download/${OCM_VERSION}/ocm-x86_64-unknown-linux-gnu.tar.gz" \
    -o "$ocm_archive"
  echo "${OCM_SHA256}  ${ocm_archive}" | sha256sum -c -
  rm -rf "$ocm_root"
  mkdir -p "$ocm_root"
  tar -xzf "$ocm_archive" -C "$ocm_root"
  chmod 0755 "$ocm_root/ocm"
}

prepare_sut() {
  ! id "$SUT_USER" >/dev/null 2>&1 || die "dedicated lease already has ${SUT_USER}"
  useradd --create-home --shell /bin/bash --user-group "$SUT_USER"
  local uid
  uid="$(id -u "$SUT_USER")"

  install -d -m 0700 -o "$SUT_USER" -g "$SUT_USER" "/home/${SUT_USER}/.cache"
  [[ -z "$(find "/home/${SUT_USER}/.cache" -mindepth 1 -print -quit)" ]] ||
    die "SUT cache is not empty"
  for credential_path in .aws .config/gh .gitconfig .npmrc; do
    [[ ! -e "/home/${SUT_USER}/${credential_path}" ]] ||
      die "SUT home unexpectedly contains ${credential_path}"
  done
  if as_sut sudo -n true >/dev/null 2>&1; then
    die "SUT unexpectedly has sudo"
  fi

  iptables -I OUTPUT -m owner --uid-owner "$uid" -d 169.254.169.254/32 -j REJECT
  iptables -I OUTPUT -m owner --uid-owner "$uid" -d 169.254.170.2/32 -j REJECT
  if as_sut curl -fsS --connect-timeout 1 --max-time 2 \
    http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then
    die "SUT can reach EC2 IMDS"
  fi

  local dirty_env
  dirty_env="$(as_sut env | grep -E '^(ACTIONS_|AWS_|CRABBOX_|GITHUB_|RUNNER_)' || true)"
  [[ -z "$dirty_env" ]] || die "SUT inherited control-plane environment"

  loginctl enable-linger "$SUT_USER"
  systemctl start "user@${uid}.service"
  [[ -S "/run/user/${uid}/systemd/private" ]] || die "SUT systemd user session is unavailable"
}

run_sut() {
  local lane="$1" root="$2" profile="$3" repeat="$4" contract="$5"
  local include_filters="$6" expected_entries="$7" fail_on_regression="$8"
  local openclaw="$root/openclaw" kova="$root/kova"
  local report_dir="$openclaw/.artifacts/kova/reports/$lane"
  local bundle_dir="$openclaw/.artifacts/kova/bundles/$lane"
  local summary_dir="$openclaw/.artifacts/kova/summaries"
  cd "$openclaw"

  if [[ "$lane" == "cleanup-probe" ]]; then
    return 42
  fi

  npm --prefix "/home/${SUT_USER}/.local" install --no-audit --no-fund "pnpm@${PNPM_VERSION}"
  pnpm install --frozen-lockfile

  if [[ "$lane" == "source" ]]; then
    local source_dir="$openclaw/.artifacts/openclaw-performance/source/mock-provider"
    mkdir -p "$source_dir"
    OPENCLAW_BUILD_PRIVATE_QA=1 node --import tsx scripts/build-all.mts sourcePerformance
    pnpm test:gateway:cpu-scenarios \
      --output-dir "$source_dir/gateway-cpu" --runs "$repeat" --warmup 1 --skip-qa \
      --startup-case default
    pnpm test:extensions:memory -- --json "$source_dir/extension-memory.json"
    cat > "$source_dir/index.md" <<EOF
# OpenClaw Source Performance

- Tested SHA: $(git rev-parse HEAD)
- Runs: ${repeat}
- Execution: disposable AWS Crabbox SUT
EOF
    return
  fi

  npm --prefix "$kova" ci --ignore-scripts --no-audit --no-fund
  mkdir -p "/home/${SUT_USER}/.local/bin" "$report_dir" "$bundle_dir" "$summary_dir"
  cat > "/home/${SUT_USER}/.local/bin/kova" <<EOF
#!/usr/bin/env bash
export KOVA_HOME="/home/${SUT_USER}/.kova"
exec node "$kova/bin/kova.mjs" "\$@"
EOF
  chmod 0755 "/home/${SUT_USER}/.local/bin/kova"

  OPENCLAW_BUILD_PRIVATE_QA=1 node --import tsx scripts/build-all.mts sourcePerformance
  local deep=() gate=() timeout_ms=300000
  [[ "$lane" == "mock-deep-profile" ]] && deep=(--deep-profile)
  [[ "$fail_on_regression" == true ]] && gate=(--gate)
  [[ "$profile" == release ]] && timeout_ms=900000
  kova matrix plan \
    --profile "$profile" --target "local-build:$openclaw" --include "$include_filters" \
    --parallel 1 --repeat "$repeat" --json > "$report_dir/plan.json"

  set +e
  KOVA_OPENCLAW_CONFIG_CONTRACT="$contract" KOVA_SCENARIO_TIMEOUT_MS="$timeout_ms" \
    kova matrix run \
      --profile "$profile" --target "local-build:$openclaw" --include "$include_filters" \
      --parallel 1 --repeat "$repeat" --auth mock --timeout-ms "$timeout_ms" \
      --report-dir "$report_dir" --execute --json "${deep[@]}" "${gate[@]}"
  local status=$?
  set -e

  local report
  report="$(find "$report_dir" -maxdepth 1 -type f -name '*.json' ! -name plan.json ! -name '*.summary.json' -print -quit)"
  [[ -n "$report" ]] || die "Kova did not produce a report"
  kova report bundle "$report" --output-dir "$bundle_dir" --json > "$bundle_dir/bundle.json"
  cat > "$summary_dir/${lane}.md" <<EOF
# OpenClaw Kova Performance

- Lane: ${lane}
- Tested SHA: $(git rev-parse HEAD)
- Kova SHA: $(git -C "$kova" rev-parse HEAD)
- Expected release entries: ${expected_entries}
- Exit code: ${status}
EOF
  if [[ "$fail_on_regression" == "true" ]]; then
    return "$status"
  fi
}

quiesce_sut() {
  local uid deadline
  uid="$(id -u "$SUT_USER")"
  loginctl disable-linger "$SUT_USER"
  systemctl stop "user@${uid}.service"
  pkill -KILL -u "$uid" 2>/dev/null || true
  deadline=$((SECONDS + 20))
  while pgrep -u "$uid" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "SUT processes survived termination"
    sleep 1
  done
}

write_payload() {
  local lane="$1" root="$2" control_workspace="$3" tested_ref="$4"
  local openclaw_sha="$5" kova_sha="$6" workflow_sha="$7"
  local run_id="$8" run_attempt="$9" crabbox_commit="${10}" crabbox_version="${11}"
  local started_at="${12}" finished_at="${13}"
  local profile="${14}" repeat="${15}" contract="${16}" include_filters="${17}"
  local fail_on_regression="${18}"
  local output="$control_workspace/.artifacts/performance-crabbox/$lane"
  local manifest="$output/artifacts.jsonl" payload="$output/payload.tar.gz"
  local paths=()

  case "$lane" in
    mock-provider | mock-deep-profile)
      paths=(
        ".artifacts/kova/reports/$lane"
        ".artifacts/kova/bundles/$lane"
        ".artifacts/kova/summaries/$lane.md"
      )
      ;;
    source) paths=(".artifacts/openclaw-performance/source") ;;
    *) die "unsupported payload lane $lane" ;;
  esac

  install -d -m 0755 "$output"
  : > "$manifest"
  local file_count=0 total_bytes=0 path file rel size sha
  for path in "${paths[@]}"; do
    [[ -e "$root/openclaw/$path" ]] || die "missing artifact path $path"
    while IFS= read -r -d '' file; do
      [[ ! -L "$file" ]] || die "artifact symlinks are forbidden"
      rel="${file#"$root/openclaw/"}"
      [[ "$rel" == .artifacts/* && "$rel" != *"/../"* ]] || die "unsafe artifact path $rel"
      size="$(file_size "$file")"
      ((size > 0 && size <= MAX_ARTIFACT_FILE_BYTES)) || die "artifact size is out of bounds: $rel"
      sha="$(file_sha256 "$file")"
      jq -cn --arg path "$rel" --argjson size "$size" --arg sha256 "$sha" \
        '{path:$path,size:$size,sha256:$sha256}' >> "$manifest"
      file_count=$((file_count + 1))
      total_bytes=$((total_bytes + size))
    done < <(find "$root/openclaw/$path" -type f -print0 | sort -z)
  done
  ((file_count > 0 && file_count <= MAX_ARTIFACT_FILES)) || die "artifact file count is out of bounds"
  ((total_bytes <= MAX_ARTIFACT_BYTES)) || die "artifact payload is too large"
  jq -sr 'sort_by(.path)' "$manifest" > "$output/artifacts.json"
  jq -r '.[].path' "$output/artifacts.json" |
    tar -C "$root/openclaw" -czf "$payload" -T -

  jq -n \
    --arg lane "$lane" --arg testedRef "$tested_ref" \
    --arg openclawSha "$openclaw_sha" --arg kovaSha "$kova_sha" \
    --arg workflowSha "$workflow_sha" --arg runId "$run_id" --arg runAttempt "$run_attempt" \
    --arg crabboxCommit "$crabbox_commit" --arg crabboxVersion "$crabbox_version" \
    --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    --arg profile "$profile" --arg repeat "$repeat" --arg contract "$contract" \
    --arg includeFilters "$include_filters" --arg failOnRegression "$fail_on_regression" \
    --slurpfile artifacts "$output/artifacts.json" \
    '{
      schemaVersion:1,lane:$lane,testedRef:$testedRef,openclawSha:$openclawSha,kovaSha:$kovaSha,
      workflow:{sha:$workflowSha,runId:$runId,runAttempt:$runAttempt},
      crabbox:{commit:$crabboxCommit,version:$crabboxVersion},
      command:{
        name:$lane,
        argv:["profile="+$profile,"repeat="+$repeat,"contract="+$contract,
          "include="+$includeFilters,"failOnRegression="+$failOnRegression],
        exitCode:0,startedAt:$startedAt,finishedAt:$finishedAt
      },
      isolation:{
        sutUser:"openclaw-sut",trustedHarnessRootOwned:true,noSudo:true,
        imdsBlocked:true,environmentClean:true,cachesEmptyBefore:true,
        tailscaleRequested:false,tailscaleMetadataAbsent:true
      },
      artifacts:$artifacts[0],
      lease:{provider:"aws",market:"on-demand",cleanupPolicy:"always"}
    }' > "$output/remote-evidence.json"
  rm -f "$manifest" "$output/artifacts.json"
  chmod -R a+rX "$output"
}

remote_main() {
  (($# == 14)) || die "remote mode requires 14 arguments"
  local lane="$1" openclaw_sha="$2" kova_sha="$3" workflow_sha="$4" tested_ref="$5"
  local profile="$6" repeat="$7" contract="$8" include_filters="$9"
  local expected_entries="${10}" fail_on_regression="${11}" run_id="${12}" run_attempt="${13}"
  local crabbox_version="${14}"
  require_sha openclaw_sha "$openclaw_sha"
  require_sha kova_sha "$kova_sha"
  require_sha workflow_sha "$workflow_sha"
  require_scalar tested_ref "$tested_ref"
  require_scalar crabbox_version "$crabbox_version"
  [[ "$repeat" =~ ^[1-9][0-9]*$ ]] || die "repeat must be positive"

  if ((EUID != 0)); then
    local self_sha root_script control_workspace
    self_sha="$(sha256sum "$0" | cut -d' ' -f1)"
    root_script="/usr/local/libexec/openclaw-performance-${self_sha}.sh"
    control_workspace="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"
    [[ -d "$control_workspace/.crabbox/scripts" ]] || die "Crabbox workspace is invalid"
    exec sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash -c \
      'install -D -o root -g root -m 0755 "$1" "$2"; workspace=$3; shift 3; cd "$workspace"; exec "$0" "$@"' \
      "$root_script" "$0" "$root_script" "$control_workspace" remote "$@"
  fi
  [[ "$0" == /usr/local/libexec/openclaw-performance-*.sh ]] || die "root harness is not installed"
  [[ "$(stat -c '%U:%G:%a' "$0")" == "root:root:755" ]] || die "root harness ownership is invalid"
  local installed_hash="${0##*/openclaw-performance-}"
  installed_hash="${installed_hash%.sh}"
  [[ "$(sha256sum "$0" | cut -d' ' -f1)" == "$installed_hash" ]] || die "root harness hash is invalid"

  local control_workspace="$PWD" root="/srv/openclaw-performance" started_at finished_at status
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rm -rf "$root"
  install -d -m 0755 "$root"
  install_toolchain
  prepare_sut
  clone_exact openclaw/openclaw "$openclaw_sha" "$root/openclaw"
  clone_exact openclaw/Kova "$kova_sha" "$root/kova"

  set +e
  as_sut "$(realpath "$0")" __sut \
    "$lane" "$root" "$profile" "$repeat" "$contract" "$include_filters" \
    "$expected_entries" "$fail_on_regression"
  status=$?
  set -e
  quiesce_sut
  [[ "$(as_sut git -C "$root/openclaw" rev-parse HEAD)" == "$openclaw_sha" ]] ||
    die "OpenClaw HEAD changed during SUT execution"
  [[ "$(as_sut git -C "$root/kova" rev-parse HEAD)" == "$kova_sha" ]] ||
    die "Kova HEAD changed during SUT execution"
  ((status == 0)) || return "$status"

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_payload "$lane" "$root" "$control_workspace" "$tested_ref" "$openclaw_sha" "$kova_sha" \
    "$workflow_sha" "$run_id" "$run_attempt" "$CRABBOX_COMMIT" "$crabbox_version" \
    "$started_at" "$finished_at" "$profile" "$repeat" "$contract" "$include_filters" \
    "$fail_on_regression"
}

verify_payload() {
  (($# == 6)) || die "verify mode requires lane, timing, lease, evidence, payload, and output"
  local lane="$1" timing="$2" lease_id="$3" evidence="$4" payload="$5" output="$6"
  local tmp
  tmp="$(mktemp -d)"
  VERIFY_TMP="$tmp"
  trap 'rm -rf -- "$VERIFY_TMP"' EXIT

  jq -e --arg id "$lease_id" '.leaseId == $id' "$timing" >/dev/null ||
    die "Crabbox timing did not bind the expected lease"
  jq -e --arg lane "$lane" \
    '.schemaVersion == 1 and .lane == $lane and (.artifacts | length > 0 and length <= 256)' \
    "$evidence" >/dev/null || die "remote evidence is invalid"

  tar -tzf "$payload" > "$tmp/tar-paths"
  grep -Ev '^\.artifacts/[A-Za-z0-9._/-]+$' "$tmp/tar-paths" > "$tmp/unsafe" || true
  [[ ! -s "$tmp/unsafe" ]] || die "payload contains unsafe paths"
  jq -r '.artifacts[].path' "$evidence" > "$tmp/evidence-paths"
  diff -u "$tmp/evidence-paths" "$tmp/tar-paths"
  tar -xzf "$payload" -C "$tmp"

  while IFS=$'\t' read -r path size sha; do
    [[ -f "$tmp/$path" && ! -L "$tmp/$path" ]] || die "payload file missing: $path"
    [[ "$(file_size "$tmp/$path")" == "$size" ]] || die "payload size mismatch: $path"
    [[ "$(file_sha256 "$tmp/$path")" == "$sha" ]] ||
      die "payload hash mismatch: $path"
  done < <(jq -r '.artifacts[] | [.path,.size,.sha256] | @tsv' "$evidence")

  mkdir -p "$(dirname "$output")" .artifacts
  cp -R "$tmp/.artifacts/." .artifacts/
  jq --arg leaseId "$lease_id" \
    '.lease += {id:$leaseId,stopped:true,stopError:""}' "$evidence" > "$output"
  jq -e --arg lane "$lane" --arg id "$lease_id" \
    '.schemaVersion == 1 and .lane == $lane and .lease.id == $id and .lease.stopped == true and
      .lease.stopError == ""' "$output" >/dev/null ||
    die "final evidence is invalid"
}

confirm_stop() {
  (($# == 2)) || die "confirm-stop requires Crabbox path and lease id"
  [[ -x "$1" && "$2" =~ ^cbx_[0-9a-f]{12}$ ]] || die "invalid explicit stop request"
  "$1" stop --provider aws --id "$2" >/dev/null 2>&1
}

case "${1:-}" in
  remote)
    shift
    remote_main "$@"
    ;;
  __sut)
    shift
    run_sut "$@"
    ;;
  verify)
    shift
    verify_payload "$@"
    ;;
  confirm-stop)
    shift
    confirm_stop "$@"
    ;;
  *)
    die "usage: $0 remote|verify|confirm-stop ..."
    ;;
esac
