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

build_helpers() {
  local version output=".github/crabbox/performance-control/helpers"
  [[ ! -e "$output" && ! -L "$output" ]] || die "helper output must be fresh"
  version="$(node -p 'require("./package.json").devDependencies.esbuild')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "esbuild must be pinned"
  npm exec --yes --package="esbuild@$version" -- esbuild \
    scripts/lib/kova-report-selector.mjs scripts/lib/kova-workflow-evidence.mts \
    scripts/lib/kova-report-gate.mts scripts/kova-ci-summary.mts \
    scripts/bench-cli-startup.ts scripts/openclaw-performance-source-summary.mts \
    --bundle --platform=node --format=esm --target=node24 --outbase=scripts \
    --outdir="$output" --out-extension:.js=.mjs \
    --alias:@openclaw/normalization-core/record-coerce=./packages/normalization-core/src/record-coerce.ts
  [[ "$(find "$output" -type f | LC_ALL=C sort)" == "$(printf '%s\n' \
    "$output/bench-cli-startup.mjs" "$output/kova-ci-summary.mjs" \
    "$output/lib/kova-report-gate.mjs" "$output/lib/kova-report-selector.mjs" \
    "$output/lib/kova-workflow-evidence.mjs" "$output/openclaw-performance-source-summary.mjs")" ]] ||
    die "unexpected helper bundle set"
}

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
    PATH="/opt/node-v${NODE_VERSION}/bin:/opt/ocm-${OCM_VERSION}:/usr/local/bin:/usr/bin:/bin:/home/${SUT_USER}/.local/bin" \
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
  local helpers="$9" model="${10}" require_instrumented="${11}"
  local openclaw="$root/openclaw" kova="$root/kova"
  local report_dir="$openclaw/.artifacts/kova/reports/$lane"
  local bundle_dir="$openclaw/.artifacts/kova/bundles/$lane"
  local summary_dir="$openclaw/.artifacts/kova/summaries"
  cd "$openclaw"

  if [[ "$lane" == "cleanup-probe" ]]; then
    return 42
  fi

  npm --prefix "$HOME/.local" install --no-audit --no-fund "pnpm@${PNPM_VERSION}"
  export PATH="$HOME/.local/node_modules/.bin:$PATH"
  pnpm install --frozen-lockfile

  if [[ "$lane" == "source" ]]; then
    local source_dir="$openclaw/.artifacts/openclaw-performance/source/mock-provider"
    mkdir -p "$source_dir/mock-hello"
    if ! node -e "const fs=require('node:fs'); const scripts=require('./package.json').scripts||{}; const extensionProbe=['scripts/profile-extension-memory.mts','scripts/profile-extension-memory.mjs'].some((entry)=>fs.existsSync(entry)); process.exit(scripts['test:gateway:cpu-scenarios'] && scripts['test:extensions:memory'] && scripts.openclaw && fs.existsSync('openclaw.mjs') && extensionProbe ? 0 : 1)"; then
      printf '# OpenClaw Source Performance\n\nSource probes skipped: required probe entry points are unavailable in this tested ref.\n' > "$source_dir/index.md"
      return
    fi
    build_source_performance
    local supported_startup_cases startup_case
    local startup_case_args=()
    supported_startup_cases="$(
      node --import tsx scripts/bench-gateway-startup.ts --help |
        sed -n 's/^  \([[:alnum:]_-][[:alnum:]_-]*\) (.*/\1/p'
    )"
    for startup_case in default skipChannels preparedRuntimeCatalogStall preparedRuntimeScaleOne preparedRuntimeScaleMany oneInternalHook allInternalHooks fiftyPlugins fiftyStartupLazyPlugins; do
      if grep -Fxq "$startup_case" <<< "$supported_startup_cases"; then
        startup_case_args+=(--startup-case "$startup_case")
      fi
    done
    [[ " ${startup_case_args[*]} " == *" --startup-case default "* ]] ||
      die "target startup benchmark did not advertise its required default case"
    pnpm test:gateway:cpu-scenarios \
      --output-dir "$source_dir/gateway-cpu" --runs "$repeat" --warmup 1 --skip-qa \
      "${startup_case_args[@]}"
    pnpm test:extensions:memory -- --json "$source_dir/extension-memory.json"
    local run_index run_dir
    for ((run_index = 1; run_index <= repeat; run_index++)); do
      run_dir=".artifacts/openclaw-performance/source/mock-provider/mock-hello/run-$(printf '%03d' "$run_index")"
      pnpm openclaw qa suite --provider-mode mock-openai --model "mock-openai/$model" \
        --concurrency 1 --output-dir "$run_dir" --scenario channel-chat-baseline
    done
    source_cli_probes "$openclaw" "$source_dir" "$repeat" "$helpers"
    if node -e "const fs=require('node:fs'); const scripts=require('./package.json').scripts||{}; process.exit(scripts['test:sqlite:perf:smoke'] && fs.existsSync('scripts/bench-sqlite-state.ts') ? 0 : 1)"; then
      pnpm test:sqlite:perf:smoke
      cp .artifacts/sqlite-perf/smoke.json "$source_dir/sqlite-perf-smoke.json"
    else
      echo "SQLite state smoke probe is unavailable in this tested ref; continuing with the remaining source probes."
    fi
    node "$helpers/openclaw-performance-source-summary.mjs" \
      --source-dir "$source_dir" --output "$source_dir/index.md"
    return
  fi

  npm --prefix "$kova" ci --ignore-scripts --no-audit --no-fund
  mkdir -p "$HOME/.local/bin" "$report_dir" "$bundle_dir" "$summary_dir"
  cat > "$HOME/.local/bin/kova" <<EOF
#!/usr/bin/env bash
export KOVA_HOME="/home/${SUT_USER}/.kova"
exec node "$kova/bin/kova.mjs" "\$@"
EOF
  chmod 0755 "$HOME/.local/bin/kova"

  build_source_performance
  local timeout_ms=300000
  [[ "$profile" == release ]] && timeout_ms=900000
  local plan_json="$openclaw/.artifacts/kova/plans/$lane.json"
  mkdir -p "$(dirname "$plan_json")"
  kova matrix plan \
    --profile "$profile" --target "local-build:$openclaw" --include "$include_filters" \
    --parallel 1 --repeat "$repeat" --json > "$plan_json"
  node --input-type=module - "$plan_json" "$profile" "$include_filters" "$expected_entries" <<'NODE'
import fs from "node:fs";
const [file, profile, include, expected] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(file, "utf8"));
const filters = include.split(",");
if (!Array.isArray(plan.controls?.include) ||
    plan.controls.include.length !== filters.length ||
    plan.controls.include.some((filter, index) => filter !== filters[index])) {
  throw new Error("Kova plan did not preserve the requested include filters");
}
if (profile === "release") {
  if (!Array.isArray(plan.entries)) throw new Error("Kova release plan did not contain entries");
  const actual = plan.entries.map((entry) => {
    if (entry.status !== "SELECTED" || !entry.scenario?.id || !entry.state?.id) {
      throw new Error("Kova release plan contained an invalid selected entry");
    }
    return `${entry.scenario.id}:${entry.state.id}`;
  }).sort();
  const required = expected.split(",").sort();
  if (actual.length !== required.length || actual.some((entry, index) => entry !== required[index])) {
    throw new Error("Kova release plan entries did not match the required lane coverage");
  }
}
NODE
  local args=(
    matrix run --profile "$profile" --target "local-build:$openclaw" --include "$include_filters"
    --parallel 1 --repeat "$repeat" --auth mock --timeout-ms "$timeout_ms"
    --report-dir "$report_dir" --execute --json
  )
  [[ "$lane" != "mock-deep-profile" ]] || args+=(--deep-profile)
  [[ "$fail_on_regression" != true ]] || args+=(--gate)
  set +e
  KOVA_OPENCLAW_CONFIG_CONTRACT="$contract" KOVA_SCENARIO_TIMEOUT_MS="$timeout_ms" \
    kova "${args[@]}" \
      2>&1 | tee "$report_dir/$lane.log"
  local status=${PIPESTATUS[0]}
  set -e

  local report
  report="$(node "$helpers/lib/kova-report-selector.mjs" --report-dir "$report_dir")"
  local evidence_status=0 bundle_status=0 summary_status=0 effective_status="$status"
  node "$helpers/lib/kova-workflow-evidence.mjs" \
    --plan "$plan_json" --report "$report" --profile "$profile" \
    --target "local-build:$openclaw" --repeat "$repeat" --include "$include_filters" \
    --auth mock --model "$model" || evidence_status=$?
  if [[ "$evidence_status" == 0 && "$fail_on_regression" == true && "$status" != 0 ]]; then
    local gate_args=("$report")
    [[ "$require_instrumented" != true ]] || gate_args+=(--require-instrumented-performance-contract)
    if node "$helpers/lib/kova-report-gate.mjs" "${gate_args[@]}"; then
      effective_status=0
    fi
  fi
  kova report bundle "$report" --output-dir "$bundle_dir" --json > "$bundle_dir/bundle.json" || bundle_status=$?
  node "$helpers/kova-ci-summary.mjs" --report "$report" \
    --output "$summary_dir/$lane.md" --lane "$lane" || summary_status=$?
  node --input-type=module - "$report" "$status" "$evidence_status" "$bundle_status" "$summary_status" <<'NODE'
import fs from "node:fs";
const [file, command, evidence, bundle, summary] = process.argv.slice(2);
const metadata = fs.lstatSync(file);
if (!metadata.isFile() || metadata.size > 50000000) throw new Error("invalid diagnostic report file");
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const text = (value) => typeof value === "string" ? value.slice(0, 512)
  .replace(/\/(?:Users|home|private|srv|work|tmp)\/[^\s"'<>]+/g, "<path>")
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<address>") : "";
const records = Array.isArray(report.records) ? report.records.slice(0, 32).map((record) => ({
  scenario: text(record?.scenario), state: text(record?.state?.id), status: text(record?.status),
  reason: text(record?.failureReason || record?.error?.message),
})) : [];
console.log("performance-kova " + JSON.stringify({
  commandExit: Number(command), evidenceExit: Number(evidence),
  bundleExit: Number(bundle), summaryExit: Number(summary), records,
}));
NODE
  ((evidence_status == 0 && bundle_status == 0 && summary_status == 0)) ||
    die "Kova evidence, bundle, or summary validation failed"
  [[ -s "$bundle_dir/bundle.json" && -s "$summary_dir/$lane.md" ]] ||
    die "Kova bundle or summary evidence is missing"
  [[ "$fail_on_regression" != true ]] || return "$effective_status"
}

build_source_performance() {
  if [[ -f scripts/build-all.mts ]] &&
    node --import tsx scripts/build-all.mts --help | grep -Fxq '  sourcePerformance'; then
    OPENCLAW_BUILD_PRIVATE_QA=1 node --import tsx scripts/build-all.mts sourcePerformance
  elif [[ -f scripts/build-all.mjs ]] &&
    node scripts/build-all.mjs --help | grep -Fxq '  sourcePerformance'; then
    OPENCLAW_BUILD_PRIVATE_QA=1 node scripts/build-all.mjs sourcePerformance
  else
    pnpm build
  fi
}

source_cli_probes() (
  local openclaw="$1" source_dir="$2" repeat="$3" helpers="$4"
  local gateway_home gateway_readiness_home gateway_port gateway_token gateway_pid=""
  gateway_home="$(mktemp -d)"
  gateway_readiness_home="$(mktemp -d)"
  cleanup_gateway() {
    if [[ -n "$gateway_pid" ]] && kill -0 "$gateway_pid" 2>/dev/null; then
      kill "$gateway_pid" 2>/dev/null || true
      wait "$gateway_pid" 2>/dev/null || true
    fi
    rm -rf "$gateway_home" "$gateway_readiness_home"
  }
  trap cleanup_gateway EXIT
  gateway_port="$(node -e "const net=require('node:net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{ console.log(s.address().port); s.close(); });")"
  gateway_token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  local gateway_state="$gateway_home/.openclaw" gateway_config="$gateway_home/.openclaw/openclaw.json"
  local readiness_state="$gateway_readiness_home/.openclaw" readiness_config="$gateway_readiness_home/.openclaw/openclaw.json"
  local gateway_log="$source_dir/cli-gateway.log" readiness_log="$source_dir/cli-gateway-readiness.log"
  mkdir -p "$gateway_state" "$readiness_state"
  local catalog_refresh_config=""
  if grep -q 'catalogRefresh:' src/config/zod-schema.core.ts; then
    catalog_refresh_config='"models": { "catalogRefresh": { "enabled": false } },'
  fi
  cat > "$gateway_config" <<EOF
{
  "agents": { "defaults": { "heartbeat": { "every": "0m" } } },
  "browser": { "enabled": false },
  ${catalog_refresh_config}
  "update": { "checkOnStart": false },
  "gateway": {
    "mode": "local", "port": ${gateway_port}, "bind": "loopback",
    "auth": { "mode": "token" }, "controlUi": { "enabled": false },
    "tailscale": { "mode": "off" }
  },
  "plugins": { "enabled": true, "entries": { "browser": { "enabled": false } } }
}
EOF
  cp "$gateway_config" "$readiness_config"
  OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_home" \
    OPENCLAW_STATE_DIR="$gateway_state" OPENCLAW_CONFIG_PATH="$gateway_config" \
    OPENCLAW_GATEWAY_PORT="$gateway_port" OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_CRON=1 \
    node dist/entry.js gateway run --bind loopback --port "$gateway_port" --auth token --allow-unconfigured --force \
    > "$gateway_log" 2>&1 &
  gateway_pid="$!"
  local deadline=$((SECONDS + 120)) remaining probe_timeout
  while true; do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || die "timed out waiting for gateway HTTP health"
    probe_timeout="$remaining"
    ((probe_timeout <= 5)) || probe_timeout=5
    if curl -fsS --connect-timeout 2 --max-time "$probe_timeout" "http://127.0.0.1:$gateway_port/healthz" >/dev/null; then
      break
    fi
    kill -0 "$gateway_pid" 2>/dev/null || die "gateway exited before HTTP health"
    sleep 1
  done
  while true; do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || die "timed out waiting for gateway WebSocket health"
    if OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_readiness_home" \
      OPENCLAW_STATE_DIR="$readiness_state" OPENCLAW_CONFIG_PATH="$readiness_config" \
      node dist/entry.js gateway health --port "$gateway_port" --timeout "$((remaining * 1000))" \
      --json > "$readiness_log" 2>&1; then
      break
    fi
    kill -0 "$gateway_pid" 2>/dev/null || die "gateway exited before WebSocket health"
    ((SECONDS >= deadline)) || sleep 1
  done
  OPENCLAW_GATEWAY_TOKEN="$gateway_token" OPENCLAW_HOME="$gateway_home" \
    OPENCLAW_STATE_DIR="$gateway_state" OPENCLAW_CONFIG_PATH="$gateway_config" \
    OPENCLAW_GATEWAY_PORT="$gateway_port" \
    node "$helpers/bench-cli-startup.mjs" --entry "$openclaw/openclaw.mjs" \
    --case gatewayHealthJsonWarmState --case gatewayHealthJsonFreshState \
    --case configGetGatewayPort --runs "$repeat" --warmup 1 --output "$source_dir/cli-startup.json"
)

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

artifact_metadata() {
  local phase="$1" workspace="$2" lane="$3" path metadata
  printf 'performance-export phase=%s uid=%s gid=%s workspace=%s\n' \
    "$phase" "$(id -u)" "$(id -g)" "$(printf '%s' "$workspace" | sha256sum | cut -d' ' -f1)"
  for path in .artifacts .artifacts/performance-crabbox ".artifacts/performance-crabbox/$lane" \
    ".artifacts/performance-crabbox/$lane/payload.tar.gz" \
    ".artifacts/performance-crabbox/$lane/remote-evidence.json"; do
    metadata="$(stat -c 'uid=%u gid=%g mode=%a size=%s' "$workspace/$path" 2>/dev/null || printf unavailable)"
    printf 'performance-export path=%s %s readable=%s searchable=%s\n' "$path" "$metadata" \
      "$([[ -r "$workspace/$path" ]] && echo true || echo false)" \
      "$([[ -x "$workspace/$path" ]] && echo true || echo false)"
  done
}

write_payload() {
  local lane="$1" root="$2" control_workspace="$3" tested_ref="$4"
  local openclaw_sha="$5" kova_sha="$6" workflow_sha="$7"
  local run_id="$8" run_attempt="$9" crabbox_commit="${10}" crabbox_version="${11}"
  local started_at="${12}" finished_at="${13}"
  local profile="${14}" repeat="${15}" contract="${16}" include_filters="${17}"
  local fail_on_regression="${18}" workload_status="${19}"
  local output="$control_workspace/.artifacts/performance-crabbox/$lane"
  local manifest="$output/artifacts.jsonl" payload="$output/payload.tar.gz"
  local paths=()

  case "$lane" in
    mock-provider | mock-deep-profile)
      paths=(
        ".artifacts/kova/plans/$lane.json"
        ".artifacts/kova/reports/$lane"
        ".artifacts/kova/bundles/$lane"
        ".artifacts/kova/summaries/$lane.md"
      )
      ;;
    source) paths=(".artifacts/openclaw-performance/source") ;;
    *) die "unsupported payload lane $lane" ;;
  esac

  [[ -d "$output" && ! -L "$output" ]] || die "collector export directory was not prepared"
  : > "$manifest"
  local file_count=0 total_bytes=0 path file rel size sha
  for path in "${paths[@]}"; do
    [[ -e "$root/openclaw/$path" ]] || die "missing artifact path $path"
    while IFS= read -r -d '' file; do
      [[ ! -L "$file" ]] || die "artifact symlinks are forbidden"
      rel="${file#"$root/openclaw/"}"
      [[ "$rel" =~ ^\.artifacts/[A-Za-z0-9._/-]+$ && "$rel" != *"/../"* ]] ||
        die "unsafe artifact path"
      [[ "$(as_sut /usr/bin/realpath "$file")" == "$file" ]] || die "artifact symlink ancestors are forbidden"
      size="$(as_sut /usr/bin/stat -c %s "$file")"
      ((size > 0 && size <= MAX_ARTIFACT_FILE_BYTES)) || die "artifact size is out of bounds: $rel"
      sha="$(as_sut /usr/bin/sha256sum "$file" | cut -d' ' -f1)"
      jq -cn --arg path "$rel" --argjson size "$size" --arg sha256 "$sha" \
        '{path:$path,size:$size,sha256:$sha256}' >> "$manifest"
      file_count=$((file_count + 1))
      total_bytes=$((total_bytes + size))
      ((file_count <= MAX_ARTIFACT_FILES && total_bytes <= MAX_ARTIFACT_BYTES)) ||
        die "artifact payload is too large"
    done < <(as_sut /usr/bin/find "$root/openclaw/$path" -type f -print0 | sort -z)
  done
  ((file_count > 0 && file_count <= MAX_ARTIFACT_FILES)) || die "artifact file count is out of bounds"
  ((total_bytes <= MAX_ARTIFACT_BYTES)) || die "artifact payload is too large"
  jq -sr 'sort_by(.path)' "$manifest" > "$output/artifacts.json"
  jq -jr '.[] | .path + "\u0000"' "$output/artifacts.json" |
    as_sut /usr/bin/tar --dereference -C "$root/openclaw" -czf - --null --verbatim-files-from -T - > "$payload"

  jq -n \
    --arg lane "$lane" --arg testedRef "$tested_ref" \
    --arg openclawSha "$openclaw_sha" --arg kovaSha "$kova_sha" \
    --arg workflowSha "$workflow_sha" --arg runId "$run_id" --arg runAttempt "$run_attempt" \
    --arg crabboxCommit "$crabbox_commit" --arg crabboxVersion "$crabbox_version" \
    --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    --arg profile "$profile" --arg repeat "$repeat" --arg contract "$contract" \
    --arg includeFilters "$include_filters" --arg failOnRegression "$fail_on_regression" \
    --argjson exitCode "$workload_status" \
    --slurpfile artifacts "$output/artifacts.json" \
    '{
      schemaVersion:1,lane:$lane,testedRef:$testedRef,openclawSha:$openclawSha,kovaSha:$kovaSha,
      workflow:{sha:$workflowSha,runId:$runId,runAttempt:$runAttempt},
      crabbox:{commit:$crabboxCommit,version:$crabboxVersion},
      command:{
        name:$lane,
        argv:["profile="+$profile,"repeat="+$repeat,"contract="+$contract,
          "include="+$includeFilters,"failOnRegression="+$failOnRegression],
        exitCode:$exitCode,startedAt:$startedAt,finishedAt:$finishedAt
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
  chmod 0644 "$payload" "$output/remote-evidence.json"
  artifact_metadata producer "$control_workspace" "$lane"
}

remote_main() {
  (($# == 16)) || die "remote mode requires 16 arguments"
  local lane="$1" openclaw_sha="$2" kova_sha="$3" workflow_sha="$4" tested_ref="$5"
  local profile="$6" repeat="$7" contract="$8" include_filters="$9"
  local expected_entries="${10}" fail_on_regression="${11}" run_id="${12}" run_attempt="${13}"
  local crabbox_version="${14}"
  local model="${15}" require_instrumented="${16}"
  case "$lane" in
    source | mock-provider | mock-deep-profile | cleanup-probe) ;;
    *) die "unsupported lane $lane" ;;
  esac
  require_sha openclaw_sha "$openclaw_sha"
  require_sha kova_sha "$kova_sha"
  require_sha workflow_sha "$workflow_sha"
  require_scalar tested_ref "$tested_ref"
  require_scalar crabbox_version "$crabbox_version"
  require_scalar model "$model"
  [[ "$require_instrumented" == true || "$require_instrumented" == false ]] ||
    die "instrumented contract requirement must be boolean"
  [[ "$repeat" =~ ^[1-9][0-9]*$ ]] || die "repeat must be positive"

  if ((EUID != 0)); then
    local self_sha root_script control_workspace
    self_sha="$(sha256sum "$0" | cut -d' ' -f1)"
    root_script="/usr/local/libexec/openclaw-performance-${self_sha}.sh"
    control_workspace="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"
    [[ -d "$control_workspace/.crabbox/scripts" ]] || die "Crabbox workspace is invalid"
    [[ "${CRABBOX_LEASE_ID:-}" =~ ^cbx_[0-9a-f]{12}$ &&
      "$control_workspace" == "/work/crabbox/$CRABBOX_LEASE_ID/openclaw" ]] ||
      die "expected dedicated raw workspace"
    local hydration="$HOME/.crabbox/actions/$CRABBOX_LEASE_ID.env"
    [[ ! -e "$hydration" && ! -L "$hydration" ]] || die "hydrated workspace is forbidden"
    # The SSH collector must own each private ancestor before root writes the payload.
    local path status=0
    for path in .artifacts .artifacts/performance-crabbox ".artifacts/performance-crabbox/$lane"; do
      [[ ! -L "$control_workspace/$path" ]] || die "collector export path is a symlink"
      install -d -m 0700 "$control_workspace/$path"
    done
    [[ ! -e "$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json" ]] ||
      die "workload receipt already exists"
    artifact_metadata collector-before "$control_workspace" "$lane"
    sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash -c \
      'install -D -o root -g root -m 0755 "$1" "$2"; workspace=$3; shift 3; cd "$workspace"; exec "$0" "$@"' \
      "$root_script" "$0" "$root_script" "$control_workspace" remote "$@" || status=$?
    artifact_metadata collector-after "$control_workspace" "$lane"
    # Always terminate candidate output with the collector's own result, including null on failure.
    local receipt="$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json" result=null
    if [[ -f "$receipt" && ! -L "$receipt" &&
      "$(stat -c '%u:%g:%a' "$receipt")" == "0:0:644" &&
      ! -e "$hydration" && ! -L "$hydration" ]]; then
      result="$(jq -c --arg workspace "$control_workspace" --arg runId "$CRABBOX_RUN_ID" \
        '. + {workspace:$workspace,runId:$runId,noHydration:true}' "$receipt")"
    fi
    printf 'performance-result %s\n' "$result"
    return "$status"
  fi
  [[ "$0" == /usr/local/libexec/openclaw-performance-*.sh ]] || die "root harness is not installed"
  [[ "$(stat -c '%U:%G:%a' "$0")" == "root:root:755" ]] || die "root harness ownership is invalid"
  local installed_hash="${0##*/openclaw-performance-}"
  installed_hash="${installed_hash%.sh}"
  [[ "$(sha256sum "$0" | cut -d' ' -f1)" == "$installed_hash" ]] || die "root harness hash is invalid"

  local control_workspace="$PWD" root="/srv/openclaw-performance" started_at finished_at status
  rm -rf "$root"
  install -d -m 0755 "$root"
  install_toolchain
  local helpers="/usr/local/libexec/openclaw-performance-helpers"
  local helper
  for helper in lib/kova-report-selector.mjs lib/kova-workflow-evidence.mjs \
    lib/kova-report-gate.mjs kova-ci-summary.mjs bench-cli-startup.mjs \
    openclaw-performance-source-summary.mjs; do
    install -D -o root -g root -m 0644 \
      "$control_workspace/.github/crabbox/performance-control/helpers/$helper" "$helpers/$helper"
  done
  prepare_sut
  clone_exact openclaw/openclaw "$openclaw_sha" "$root/openclaw"
  clone_exact openclaw/Kova "$kova_sha" "$root/kova"

  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  as_sut "$(realpath "$0")" __sut \
    "$lane" "$root" "$profile" "$repeat" "$contract" "$include_filters" \
    "$expected_entries" "$fail_on_regression" "$helpers" "$model" "$require_instrumented"
  status=$?
  set -e
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  quiesce_sut
  [[ "$(as_sut git -C "$root/openclaw" rev-parse HEAD)" == "$openclaw_sha" ]] ||
    die "OpenClaw HEAD changed during SUT execution"
  [[ "$(as_sut git -C "$root/kova" rev-parse HEAD)" == "$kova_sha" ]] ||
    die "Kova HEAD changed during SUT execution"
  [[ "$lane" != cleanup-probe ]] || return "$status"

  local export_status
  set +e
  (
    set -e
    write_payload "$lane" "$root" "$control_workspace" "$tested_ref" "$openclaw_sha" "$kova_sha" \
    "$workflow_sha" "$run_id" "$run_attempt" "$CRABBOX_COMMIT" "$crabbox_version" \
    "$started_at" "$finished_at" "$profile" "$repeat" "$contract" "$include_filters" \
    "$fail_on_regression" "$status"
  )
  export_status=$?
  set -e
  local receipt="$control_workspace/.artifacts/performance-crabbox/$lane/workload-result.json"
  jq -n --argjson exitCode "$status" --argjson exportExitCode "$export_status" \
    --arg startedAt "$started_at" --arg finishedAt "$finished_at" \
    '{exitCode:$exitCode,exportExitCode:$exportExitCode,startedAt:$startedAt,finishedAt:$finishedAt}' > "$receipt"
  chmod 0644 "$receipt"
  ((status == 0)) || return "$status"
  return "$export_status"
}

verify_payload() {
  (($# == 7)) || die "verify mode requires lane, timing, lease, evidence, payload, output, and expectations"
  local lane="$1" timing="$2" lease_id="$3" evidence="$4" payload="$5" output="$6"
  local expected="$7"
  local tmp
  tmp="$(mktemp -d)"
  VERIFY_TMP="$tmp"
  trap 'rm -rf -- "$VERIFY_TMP"' EXIT

  jq -e --arg id "$lease_id" --slurpfile expected "$expected" \
    '.provider == "aws" and .leaseId == $id and . == $expected[0].timing and
      $expected[0].stopped == true' "$timing" >/dev/null ||
    die "Crabbox timing did not bind the expected lease"
  jq -e --arg lane "$lane" --slurpfile expected "$expected" \
    '. as $e | $expected[0] as $x |
      .schemaVersion == 1 and .lane == $lane and
      all(["testedRef","openclawSha","kovaSha","workflow","crabbox","command"][]; $e[.] == $x[.]) and
      (.artifacts | length > 0 and length <= 256) and
      (.artifacts | map(.path) | length == (unique | length)) and
      all(.artifacts[]; (.size > 0 and .size <= 50000000) and
        (.path | test("^\\.artifacts/[A-Za-z0-9._/-]+$")) and
        (.path | split("/") | all(. != ".." and . != "."))) and
      ([.artifacts[].size] | add <= 250000000)' \
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
  build-helpers)
    build_helpers
    ;;
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
    die "usage: $0 build-helpers|remote|verify|confirm-stop ..."
    ;;
esac
