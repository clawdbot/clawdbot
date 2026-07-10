#!/usr/bin/env bash
set -euo pipefail

read_positive_int_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [[ -z "${!name+x}" ]]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 )); then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf "%s\n" "$((10#$value))"
}

read_nonnegative_int_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [[ -z "${!name+x}" ]]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf "%s\n" "$((10#$value))"
}

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
SMOKE_MODE="${OPENCLAW_INSTALL_SMOKE_MODE:-install}"
SMOKE_PREVIOUS_VERSION="${OPENCLAW_INSTALL_SMOKE_PREVIOUS:-}"
SKIP_PREVIOUS="${OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS:-0}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"
FRESH_VERSION="${OPENCLAW_INSTALL_FRESH_VERSION:-}"
FRESH_TAG_URL="${OPENCLAW_INSTALL_FRESH_TAG_URL:-}"
UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_UPDATE_BASELINE:-latest}"
UPDATE_BASELINE_TAG_URL="${OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL:-}"
UPDATE_EXPECT_VERSION="${OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION:-}"
UPDATE_TAG_URL="${OPENCLAW_INSTALL_UPDATE_TAG_URL:-}"
SELF_UPDATE_WARNING_FIXED_VERSION="${OPENCLAW_INSTALL_SELF_UPDATE_WARNING_FIXED_VERSION:-2026.5.25}"
FRESHNESS_VERSION="${OPENCLAW_INSTALL_FRESHNESS_VERSION:-latest}"
# npm min-release-age is days; 10000 keeps the control failure independent of normal release cadence.
FRESHNESS_MIN_RELEASE_AGE="${OPENCLAW_INSTALL_FRESHNESS_MIN_RELEASE_AGE:-10000}"
FRESHNESS_NPM_VERSION="${OPENCLAW_INSTALL_FRESHNESS_NPM_VERSION:-11.14.1}"
HEARTBEAT_INTERVAL="$(read_nonnegative_int_env OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL 60)"
INSTALL_COMMAND_TIMEOUT="$(read_positive_int_env OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT 900)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

emit_status() {
  if [[ -w /dev/tty ]]; then
    printf "%s\n" "$*" >/dev/tty
  else
    printf "%s\n" "$*" >&2
  fi
}

global_package_root() {
  local npm_root
  npm_root="$(quiet_npm root -g 2>/dev/null || true)"
  if [[ -n "$npm_root" ]]; then
    printf "%s/%s" "$npm_root" "$PACKAGE_NAME"
  fi
}

describe_installed_package() {
  local root="$1"
  local files="missing"
  local size="missing"
  local version="missing"
  if [[ -d "$root" ]]; then
    files="$(find "$root" -type f 2>/dev/null | wc -l | tr -d " ")"
    size="$(du -sh "$root" 2>/dev/null | cut -f1 || true)"
    version="$(
      node -e '
try {
  process.stdout.write(String(require(`${process.argv[1]}/package.json`).version ?? "missing"));
} catch {
  process.stdout.write("missing");
}
' "$root"
    )"
  fi
  printf "version=%s size=%s files=%s root=%s" "$version" "$size" "$files" "$root"
}

print_install_audit() {
  local label="$1"
  local root
  root="$(global_package_root)"
  if [[ -n "$root" ]]; then
    echo "==> Install audit (${label}): $(describe_installed_package "$root")"
  fi
}

verify_candidate_ai_runtime() {
  echo "==> Verify installed AI runtime"
  OPENCLAW_ALLOW_ROOT=1 openclaw infer image providers --json >/dev/null
}

run_with_heartbeat() {
  local label="$1"
  shift
  local interval="$HEARTBEAT_INTERVAL"
  if [[ "$interval" == "0" ]]; then
    "$@"
    return
  fi

  local start
  local command_pid
  local heartbeat_pid
  local status
  start="$(date +%s)"
  set +e
  "$@" &
  command_pid=$!
  (
    while true; do
      sleep "$interval"
      kill -0 "$command_pid" >/dev/null 2>&1 || exit 0
      local now
      local elapsed
      local root
      now="$(date +%s)"
      elapsed=$((now - start))
      root="$(global_package_root)"
      if [[ -n "$root" ]]; then
        emit_status "==> Still running (${label}, ${elapsed}s): $(describe_installed_package "$root")"
      else
        emit_status "==> Still running (${label}, ${elapsed}s)"
      fi
    done
  ) &
  heartbeat_pid=$!
  wait "$command_pid"
  status=$?
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" >/dev/null 2>&1 || true
  set -e
  return "$status"
}

is_self_swapped_package_process_exit() {
  local stderr="$1"
  [[ "$stderr" == *"[openclaw] Failed to start CLI:"* ]] &&
    [[ "$stderr" == *"ERR_MODULE_NOT_FOUND"* ]] &&
    [[ "$stderr" == *"/node_modules/openclaw/dist/"* ]]
}

is_version_before() {
  local candidate="$1"
  local floor="$2"
  node - "$candidate" "$floor" <<'NODE'
const [, , candidate, floor] = process.argv;
function parse(version) {
  const [core, prerelease = ""] = String(version).split("-", 2);
  return {
    core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    const ln = Number.parseInt(l, 10);
    const rn = Number.parseInt(r, 10);
    const lNumeric = String(ln) === l;
    const rNumeric = String(rn) === r;
    if (lNumeric && rNumeric && ln !== rn) {
      return ln < rn ? -1 : 1;
    }
    if (lNumeric !== rNumeric) {
      return lNumeric ? -1 : 1;
    }
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}
const left = parse(candidate);
const right = parse(floor);
for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
  const l = left.core[index] ?? 0;
  const r = right.core[index] ?? 0;
  if (l < r) {
    process.exit(0);
  }
  if (l > r) {
    process.exit(1);
  }
}
const prereleaseOrder = comparePrerelease(left.prerelease, right.prerelease);
process.exit(prereleaseOrder < 0 ? 0 : 1);
NODE
}

allow_legacy_update_warning() {
  [[ "${OPENCLAW_INSTALL_ALLOW_LEGACY_UPDATE_WARNING:-0}" == "1" ]] && return 0
  is_version_before "$UPDATE_BASELINE_VERSION" "$SELF_UPDATE_WARNING_FIXED_VERSION"
}

npm_install_global() {
  local label="$1"
  shift
  run_with_heartbeat "$label" \
    timeout --kill-after=30s "${INSTALL_COMMAND_TIMEOUT}s" \
      npm \
      --loglevel=error \
      --logs-max=0 \
      --no-update-notifier \
      --no-fund \
      --no-audit \
      --no-progress \
      install -g "$@"
}

resolve_update_baseline_version() {
  if [[ -n "$UPDATE_BASELINE_TAG_URL" ]]; then
    return
  fi

  local resolved_version
  resolved_version="$(quiet_npm view "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}" version 2>/dev/null || true)"
  if [[ -z "$resolved_version" ]]; then
    echo "ERROR: failed to resolve ${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}" >&2
    return 1
  fi
  UPDATE_BASELINE_VERSION="$resolved_version"
}

run_installer_for_package_spec() {
  local install_url="$1"
  local package_spec="$2"

  timeout --kill-after=30s "${INSTALL_COMMAND_TIMEOUT}s" \
    bash -c "curl -fsSL \"\$1\" | bash -s -- --install-method npm --version \"\$2\" --no-prompt --no-onboard" \
    _ "$install_url" "$package_spec"
}

run_install_smoke() {
  if [[ -n "$FRESH_VERSION" && -n "$FRESH_TAG_URL" ]]; then
    echo "package=$PACKAGE_NAME latest=$FRESH_VERSION source=$FRESH_TAG_URL"
    echo "==> Run official installer one-liner for latest release tarball"
    OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1 \
      run_with_heartbeat "installer latest release tarball" \
        run_installer_for_package_spec "$INSTALL_URL" "$FRESH_TAG_URL"
    print_install_audit "fresh install"

    echo "==> Verify installed version"
    if [[ -n "${OPENCLAW_INSTALL_LATEST_OUT:-}" ]]; then
      # Non-root installer smoke uses the public install script path, which
      # resolves npm "latest" rather than this host-served candidate tarball.
      local latest_npm_version
      latest_npm_version="$(quiet_npm view "$PACKAGE_NAME" version 2>/dev/null || true)"
      if [[ -n "$latest_npm_version" ]]; then
        printf "%s" "$latest_npm_version" > "${OPENCLAW_INSTALL_LATEST_OUT:-}"
      else
        printf "%s" "$FRESH_VERSION" > "${OPENCLAW_INSTALL_LATEST_OUT:-}"
      fi
    fi
    verify_installed_cli "$PACKAGE_NAME" "$FRESH_VERSION"
    verify_candidate_ai_runtime

    echo "OK"
    return 0
  fi

  echo "==> Resolve npm versions"
  if [[ "$SKIP_PREVIOUS" == "1" ]]; then
    LATEST_VERSION="$(quiet_npm view "$PACKAGE_NAME" version)"
    PREVIOUS_VERSION="$LATEST_VERSION"
  elif [[ -n "$SMOKE_PREVIOUS_VERSION" ]]; then
    LATEST_VERSION="$(quiet_npm view "$PACKAGE_NAME" version)"
    PREVIOUS_VERSION="$SMOKE_PREVIOUS_VERSION"
  else
    LATEST_VERSION="$(quiet_npm view "$PACKAGE_NAME" dist-tags.latest)"
    VERSIONS_JSON="$(quiet_npm view "$PACKAGE_NAME" versions --json)"
    PREVIOUS_VERSION="$(LATEST_VERSION="$LATEST_VERSION" VERSIONS_JSON="$VERSIONS_JSON" node - <<'NODE'
const latest = String(process.env.LATEST_VERSION || "");
const raw = process.env.VERSIONS_JSON || "[]";
let versions;
try {
  versions = JSON.parse(raw);
} catch {
  versions = raw ? [raw] : [];
}
if (!Array.isArray(versions)) {
  versions = [versions];
}
if (versions.length === 0 || latest.length === 0) {
  process.exit(1);
}
const latestIndex = versions.lastIndexOf(latest);
if (latestIndex <= 0) {
  process.stdout.write(latest);
  process.exit(0);
}
process.stdout.write(String(versions[latestIndex - 1] ?? latest));
NODE
)"
  fi

  echo "package=$PACKAGE_NAME latest=$LATEST_VERSION previous=$PREVIOUS_VERSION"

  if [[ "$SKIP_PREVIOUS" == "1" ]]; then
    echo "==> Skip preinstall previous (OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1)"
  else
    echo "==> Preinstall previous (forces installer upgrade path)"
    npm_install_global "preinstall previous release" "${PACKAGE_NAME}@${PREVIOUS_VERSION}"
    print_install_audit "previous install"
  fi

  echo "==> Run official installer one-liner"
  curl -fsSL "$INSTALL_URL" | bash -s -- --no-prompt

  echo "==> Verify installed version"
  if [[ -n "${OPENCLAW_INSTALL_LATEST_OUT:-}" ]]; then
    printf "%s" "$LATEST_VERSION" > "${OPENCLAW_INSTALL_LATEST_OUT:-}"
  fi
  verify_installed_cli "$PACKAGE_NAME" "$LATEST_VERSION"

  echo "OK"
}

run_update_smoke() {
  if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then
    echo "ERROR: OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION is required for update mode" >&2
    return 1
  fi
  if [[ -z "$UPDATE_TAG_URL" ]]; then
    echo "ERROR: OPENCLAW_INSTALL_UPDATE_TAG_URL is required for update mode" >&2
    return 1
  fi

  resolve_update_baseline_version

  echo "package=$PACKAGE_NAME baseline=$UPDATE_BASELINE_VERSION target=$UPDATE_EXPECT_VERSION"
  echo "==> Install baseline release"
  if [[ -n "$UPDATE_BASELINE_TAG_URL" ]]; then
    npm_install_global "install baseline release" --omit=optional "$UPDATE_BASELINE_TAG_URL"
  else
    npm_install_global "install baseline release" --omit=optional "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}"
  fi
  print_install_audit "baseline install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_BASELINE_VERSION"

  echo "==> Run openclaw update from host-served tgz"
  local update_status
  local update_stderr_file
  local update_stderr
  local update_env=(
    env
    npm_config_omit=optional
    NPM_CONFIG_OMIT=optional
    OPENCLAW_ALLOW_ROOT=1
  )
  if allow_legacy_update_warning; then
    update_env+=(OPENCLAW_UPDATE_IN_PROGRESS=1)
  fi
  update_stderr_file="$(mktemp)"
  set +e
  UPDATE_JSON="$(
    run_with_heartbeat "openclaw update" \
      "${update_env[@]}" \
      openclaw update --tag "$UPDATE_TAG_URL" --yes --json 2>"$update_stderr_file"
  )"
  update_status=$?
  set -e
  update_stderr="$(cat "$update_stderr_file")"
  rm -f "$update_stderr_file"
  printf "%s\n" "$UPDATE_JSON"
  if [[ -n "$update_stderr" ]]; then
    printf "%s\n" "$update_stderr" >&2
  fi
  if [[ "$update_stderr" == *"config was written by version"* ]] && allow_legacy_update_warning; then
    echo "WARN: legacy baseline emitted a self-update version-skew warning; fixed baselines must not" >&2
  elif [[ "$update_stderr" == *"config was written by version"* ]]; then
    echo "ERROR: openclaw update emitted a self-update version-skew warning" >&2
    return 1
  fi
  if [[ "$update_status" -ne 0 ]]; then
    if is_self_swapped_package_process_exit "$update_stderr"; then
      echo "WARN: legacy updater process exited after self-swap; validating update JSON and installed CLI" >&2
    else
      echo "ERROR: openclaw update failed with exit code $update_status" >&2
      return "$update_status"
    fi
  fi

  UPDATE_JSON="$UPDATE_JSON" \
    UPDATE_EXPECT_VERSION="$UPDATE_EXPECT_VERSION" \
    UPDATE_BASELINE_VERSION="$UPDATE_BASELINE_VERSION" \
    UPDATE_TAG_URL="$UPDATE_TAG_URL" \
    node - <<'NODE'
function parseFirstJsonObject(raw) {
  const start = raw.indexOf("{");
  if (start < 0) {
    throw new Error("missing update JSON object");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, index + 1));
      }
    }
  }
  throw new Error("unterminated update JSON object");
}

const payload = parseFirstJsonObject(process.env.UPDATE_JSON || "{}");
const expectedVersion = String(process.env.UPDATE_EXPECT_VERSION || "");
const baselineVersion = String(process.env.UPDATE_BASELINE_VERSION || "");
const expectedUrl = String(process.env.UPDATE_TAG_URL || "");
if (payload.status !== "ok") {
  throw new Error(`expected update status ok, got ${JSON.stringify(payload.status)}`);
}
if ((payload.before?.version ?? null) !== baselineVersion) {
  throw new Error(
    `expected before.version ${baselineVersion}, got ${JSON.stringify(payload.before?.version)}`,
  );
}
if ((payload.after?.version ?? null) !== expectedVersion) {
  throw new Error(
    `expected after.version ${expectedVersion}, got ${JSON.stringify(payload.after?.version)}`,
  );
}
if (payload.reason != null) {
  throw new Error(`expected no failure reason, got ${JSON.stringify(payload.reason)}`);
}
const steps = Array.isArray(payload.steps) ? payload.steps : [];
const updateStep = steps.find((step) => step?.name === "global update");
if (!updateStep) {
  throw new Error("missing global update step in update JSON");
}
if (Number(updateStep.exitCode ?? 1) !== 0) {
  throw new Error(`global update step failed: ${JSON.stringify(updateStep)}`);
}
if (typeof updateStep.command !== "string" || !updateStep.command.includes(expectedUrl)) {
  throw new Error(`global update step missing expected tgz URL: ${JSON.stringify(updateStep)}`);
}
const doctorStep = steps.find((step) => step?.name === "openclaw doctor");
// Every baseline that passes verify_installed_cli implements this contract;
// the sole earlier npm artifact has no CLI and cannot reach this parser.
if (!doctorStep) {
  throw new Error("missing openclaw doctor step in update JSON");
}
// Exit 86 is the updater's explicit recoverable post-install doctor contract.
const doctorSucceeded = doctorStep.exitCode === 0;
const doctorWasAdvisory =
  doctorStep.exitCode === 86 &&
  doctorStep.advisory?.kind === "package-post-install-doctor";
if (!doctorSucceeded && !doctorWasAdvisory) {
  throw new Error(`openclaw doctor step failed: ${JSON.stringify(doctorStep)}`);
}
NODE

  echo "==> Verify updated version"
  print_install_audit "updated install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_EXPECT_VERSION"
  verify_candidate_ai_runtime

  echo "OK"
}

run_npm_global_smoke() {
  if [[ -z "$UPDATE_EXPECT_VERSION" ]]; then
    echo "ERROR: OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION is required for npm-global mode" >&2
    return 1
  fi
  if [[ -z "$UPDATE_TAG_URL" ]]; then
    echo "ERROR: OPENCLAW_INSTALL_UPDATE_TAG_URL is required for npm-global mode" >&2
    return 1
  fi

  resolve_update_baseline_version

  echo "package=$PACKAGE_NAME baseline=$UPDATE_BASELINE_VERSION target=$UPDATE_EXPECT_VERSION"
  echo "==> Direct npm global install candidate"
  npm_install_global "direct npm global install candidate" "$UPDATE_TAG_URL"
  print_install_audit "direct npm fresh install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_EXPECT_VERSION"

  echo "==> Direct npm global install baseline"
  if [[ -n "$UPDATE_BASELINE_TAG_URL" ]]; then
    npm_install_global "direct npm global install baseline" "$UPDATE_BASELINE_TAG_URL"
  else
    npm_install_global "direct npm global install baseline" "${PACKAGE_NAME}@${UPDATE_BASELINE_VERSION}"
  fi
  print_install_audit "direct npm baseline install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_BASELINE_VERSION"

  echo "==> Direct npm global update candidate"
  npm_install_global "direct npm global update candidate" "$UPDATE_TAG_URL"
  print_install_audit "direct npm updated install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_EXPECT_VERSION"

  echo "OK"
}

run_freshness_smoke() {
  local freshness_spec="${PACKAGE_NAME}@${FRESHNESS_VERSION}"
  local expected_version
  local current_npm_version
  local policy_home
  local plain_stdout_file
  local plain_stderr_file
  local plain_status
  policy_home="$(mktemp -d)"
  plain_stdout_file="$(mktemp)"
  plain_stderr_file="$(mktemp)"
  printf "min-release-age=%s\n" "$FRESHNESS_MIN_RELEASE_AGE" >"${policy_home}/.npmrc"

  current_npm_version="$(npm --version 2>/dev/null || true)"
  if [[ "$current_npm_version" != "$FRESHNESS_NPM_VERSION" ]]; then
    echo "==> Install npm with min-release-age support: npm@$FRESHNESS_NPM_VERSION"
    npm_install_global "install npm freshness-capable release" "npm@${FRESHNESS_NPM_VERSION}"
  fi

  expected_version="$(quiet_npm view "$freshness_spec" version 2>/dev/null || true)"
  if [[ -z "$expected_version" ]]; then
    echo "ERROR: failed to resolve $freshness_spec" >&2
    return 1
  fi

  echo "package=$PACKAGE_NAME version=$FRESHNESS_VERSION resolved=$expected_version npm=$(npm --version) min_release_age=$FRESHNESS_MIN_RELEASE_AGE"
  echo "==> Verify user npm freshness policy blocks plain npm install"
  set +e
  HOME="$policy_home" NPM_CONFIG_USERCONFIG="${policy_home}/.npmrc" \
    timeout --kill-after=30s "${INSTALL_COMMAND_TIMEOUT}s" \
      npm \
      --loglevel=error \
      --logs-max=0 \
      --no-update-notifier \
      --no-fund \
      --no-audit \
      --no-progress \
      install -g "$freshness_spec" \
    >"$plain_stdout_file" 2>"$plain_stderr_file"
  plain_status=$?
  set -e
  if [[ "$plain_status" -eq 0 ]]; then
    echo "ERROR: plain npm install unexpectedly succeeded under min-release-age policy" >&2
    return 1
  fi
  if ! grep -Eiq "No matching version|No versions available|ETARGET|ENOVERSIONS|notarget|min-release-age|minimum release age|before" \
    "$plain_stdout_file" "$plain_stderr_file"; then
    echo "ERROR: plain npm install failed without expected freshness evidence" >&2
    cat "$plain_stdout_file"
    cat "$plain_stderr_file" >&2
    return 1
  fi

  echo "==> Run installer with same npm freshness policy"
  env \
    HOME="$policy_home" \
    NPM_CONFIG_USERCONFIG="${policy_home}/.npmrc" \
    OPENCLAW_NO_ONBOARD=1 \
    OPENCLAW_NO_PROMPT=1 \
    bash -c 'curl -fsSL "$1" | bash -s -- --install-method npm --version "$2" --no-prompt --no-onboard' \
    _ "$INSTALL_URL" "$FRESHNESS_VERSION"

  echo "==> Verify installed version"
  print_install_audit "freshness install"
  verify_installed_cli "$PACKAGE_NAME" "$expected_version"

  echo "OK"
}

case "$SMOKE_MODE" in
  install)
    run_install_smoke
    ;;
  update)
    run_update_smoke
    ;;
  npm-global)
    run_npm_global_smoke
    ;;
  freshness)
    run_freshness_smoke
    ;;
  *)
    echo "ERROR: unsupported OPENCLAW_INSTALL_SMOKE_MODE=$SMOKE_MODE" >&2
    exit 1
    ;;
esac
