#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
SMOKE_MODE="${OPENCLAW_INSTALL_SMOKE_MODE:-install}"
SMOKE_PREVIOUS_VERSION="${OPENCLAW_INSTALL_SMOKE_PREVIOUS:-}"
SKIP_PREVIOUS="${OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS:-0}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"
FRESH_VERSION="${OPENCLAW_INSTALL_FRESH_VERSION:-}"
FRESH_TAG_URL="${OPENCLAW_INSTALL_FRESH_TAG_URL:-}"
UPDATE_BASELINE_VERSION="${OPENCLAW_INSTALL_UPDATE_BASELINE:-2026.4.10}"
UPDATE_BASELINE_TAG_URL="${OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL:-}"
UPDATE_EXPECT_VERSION="${OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION:-}"
UPDATE_TAG_URL="${OPENCLAW_INSTALL_UPDATE_TAG_URL:-}"
HEARTBEAT_INTERVAL="${OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL:-60}"
INSTALL_COMMAND_TIMEOUT="${OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT:-900}"
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

run_with_heartbeat() {
  local label="$1"
  shift
  local interval="$HEARTBEAT_INTERVAL"
  if ! [[ "$interval" =~ ^[0-9]+$ ]] || [[ "$interval" == "0" ]]; then
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

npm_install_global() {
  local label="$1"
  shift
  run_with_heartbeat "$label" \
    timeout --foreground "${INSTALL_COMMAND_TIMEOUT}s" \
      npm \
      --loglevel=error \
      --logs-max=0 \
      --no-update-notifier \
      --no-fund \
      --no-audit \
      --no-progress \
      install -g "$@"
}

run_install_smoke() {
  if [[ -n "$FRESH_VERSION" && -n "$FRESH_TAG_URL" ]]; then
    echo "package=$PACKAGE_NAME latest=$FRESH_VERSION source=$FRESH_TAG_URL"
    echo "==> Install latest release tarball"
    npm_install_global "install latest release tarball" --omit=optional "$FRESH_TAG_URL"
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
  update_stderr_file="$(mktemp)"
  set +e
  UPDATE_JSON="$(
    run_with_heartbeat "openclaw update" \
      env npm_config_omit=optional NPM_CONFIG_OMIT=optional \
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
  if [[ "$update_status" -ne 0 ]]; then
    echo "ERROR: openclaw update failed with exit code $update_status" >&2
    return "$update_status"
  fi

  UPDATE_JSON="$UPDATE_JSON" \
    UPDATE_EXPECT_VERSION="$UPDATE_EXPECT_VERSION" \
    UPDATE_BASELINE_VERSION="$UPDATE_BASELINE_VERSION" \
    UPDATE_TAG_URL="$UPDATE_TAG_URL" \
    node - <<'NODE'
const payload = JSON.parse(process.env.UPDATE_JSON || "{}");
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
NODE

  echo "==> Verify updated version"
  print_install_audit "updated install"
  verify_installed_cli "$PACKAGE_NAME" "$UPDATE_EXPECT_VERSION"

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
  *)
    echo "ERROR: unsupported OPENCLAW_INSTALL_SMOKE_MODE=$SMOKE_MODE" >&2
    exit 1
    ;;
esac
