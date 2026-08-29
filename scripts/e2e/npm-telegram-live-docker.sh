#!/usr/bin/env bash
# Installs an OpenClaw package candidate in Docker, performs Telegram
# onboarding/doctor recovery, then runs the Telegram QA live harness.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-npm-telegram-live-e2e" OPENCLAW_NPM_TELEGRAM_LIVE_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_NPM_TELEGRAM_DOCKER_TARGET:-build}"
PACKAGE_SPEC="${OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC:-openclaw@beta}"
PACKAGE_TGZ="${OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}"
PACKAGE_DIR="${OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR:-}"
PREPUBLISH_PLUGIN_REGISTRY_DIR="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}"
PACKAGE_LABEL="${OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL:-}"
RUN_ID="${OPENCLAW_NPM_TELEGRAM_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
OUTPUT_DIR="${OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live/$RUN_ID}"
case "$OUTPUT_DIR" in
  /*) OUTPUT_DIR_HOST="$OUTPUT_DIR" ;;
  *) OUTPUT_DIR_HOST="$ROOT_DIR/$OUTPUT_DIR" ;;
esac
OUTPUT_DIR_CONTAINER_RELATIVE=".artifacts/qa-e2e/npm-telegram-live-output"
OUTPUT_DIR_CONTAINER="/app/$OUTPUT_DIR_CONTAINER_RELATIVE"

resolve_credential_source() {
  if [ -n "${OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE:-}" ]; then
    printf "%s" "$OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE"
    return 0
  fi
  if [ -n "${OPENCLAW_QA_CREDENTIAL_SOURCE:-}" ]; then
    printf "%s" "$OPENCLAW_QA_CREDENTIAL_SOURCE"
    return 0
  fi
  if [ -n "${CI:-}" ] && [ -n "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then
    if [ -n "${OPENCLAW_QA_CONVEX_SECRET_CI:-}" ] || [ -n "${OPENCLAW_QA_CONVEX_SECRET_MAINTAINER:-}" ]; then
      printf "convex"
    fi
  fi
}

resolve_credential_role() {
  if [ -n "${OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE:-}" ]; then
    printf "%s" "$OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE"
    return 0
  fi
  if [ -n "${OPENCLAW_QA_CREDENTIAL_ROLE:-}" ]; then
    printf "%s" "$OPENCLAW_QA_CREDENTIAL_ROLE"
  fi
}

validate_openclaw_package_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^openclaw@(alpha|beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$ ]]; then
    return 0
  fi
  echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC must be openclaw@alpha, openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: $spec" >&2
  exit 1
}

resolve_package_tgz() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 0
  fi
  if [ ! -f "$candidate" ]; then
    echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ must point to an existing .tgz file; got: $candidate" >&2
    exit 1
  fi
  case "$candidate" in
    *.tgz) ;;
    *)
      echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ must point to a .tgz file; got: $candidate" >&2
      exit 1
      ;;
  esac
  local dir
  local base
  dir="$(cd "$(dirname "$candidate")" && pwd)"
  base="$(basename "$candidate")"
  printf "%s/%s" "$dir" "$base"
}

resolve_package_dir() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 0
  fi
  if [ ! -d "$candidate" ]; then
    echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR must point to an existing directory; got: $candidate" >&2
    exit 1
  fi
  (cd "$candidate" && pwd)
}

resolve_prepublish_plugin_registry_dir() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 0
  fi
  if [ ! -d "$candidate" ]; then
    echo "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR must point to an existing directory; got: $candidate" >&2
    exit 1
  fi
  (cd "$candidate" && pwd)
}

read_package_version() {
  tar -xOf "$1" package/package.json |
    node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const version = JSON.parse(raw).version;
  if (typeof version !== "string" || !version) {
    throw new Error("package tarball is missing a version");
  }
  process.stdout.write(version);
});
'
}

package_mount_args=()
registry_helper_mount_args=()
prepublish_registry_mount_args=()
package_install_source="$PACKAGE_SPEC"
package_source_kind="npm-package"
resolved_package_tgz="$(resolve_package_tgz "$PACKAGE_TGZ")"
resolved_package_dir="$(resolve_package_dir "$PACKAGE_DIR")"
resolved_prepublish_plugin_registry_dir="$(
  resolve_prepublish_plugin_registry_dir "$PREPUBLISH_PLUGIN_REGISTRY_DIR"
)"
if [ -n "$resolved_package_dir" ]; then
  if [ -z "$resolved_package_tgz" ]; then
    echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR requires OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ" >&2
    exit 1
  fi
  case "$resolved_package_tgz" in
    "$resolved_package_dir"/*) ;;
    *)
      echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ must be inside OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR" >&2
      exit 1
      ;;
  esac
  package_install_source="openclaw@$(read_package_version "$resolved_package_tgz")"
  package_source_kind="prepared-package-set"
  package_mount_args=(-v "$resolved_package_dir:/package-under-test:ro")
  registry_helper_mount_args=(
    -v "$ROOT_DIR/scripts/lib/bounded-response.mjs:/tmp/lib/bounded-response.mjs:ro"
    -v "$ROOT_DIR/scripts/e2e/lib/plugins/npm-registry-server.mjs:/tmp/openclaw-e2e/lib/plugins/npm-registry-server.mjs:ro"
  )
elif [ -n "$resolved_package_tgz" ]; then
  package_install_source="/package-under-test/$(basename "$resolved_package_tgz")"
  package_source_kind="packed-tarball"
  package_mount_args=(-v "$resolved_package_tgz:$package_install_source:ro")
else
  validate_openclaw_package_spec "$PACKAGE_SPEC"
fi
if [ -n "$resolved_prepublish_plugin_registry_dir" ]; then
  prepublish_registry_mount_args=(
    -v "$resolved_prepublish_plugin_registry_dir:/tmp/openclaw-prepublish-plugin-registry:ro"
  )
fi
if [ -z "$PACKAGE_LABEL" ]; then
  if [ -n "$resolved_package_tgz" ]; then
    PACKAGE_LABEL="$(basename "$resolved_package_tgz")"
  else
    PACKAGE_LABEL="$PACKAGE_SPEC"
  fi
fi

credential_source="$(resolve_credential_source)"
credential_role="$(resolve_credential_role)"
if [ -z "$credential_role" ] && [ "$credential_source" = "convex" ]; then
  if [ -n "${CI:-}" ]; then
    credential_role="ci"
  else
    credential_role="maintainer"
  fi
fi

validate_credential_preflight() {
  if [ "${OPENCLAW_NPM_TELEGRAM_SKIP_CREDENTIAL_PREFLIGHT:-0}" = "1" ]; then
    return 0
  fi
  if [ "$credential_source" = "convex" ]; then
    if [ -z "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then
      echo "Missing required env for Convex credential mode: OPENCLAW_QA_CONVEX_SITE_URL" >&2
      exit 1
    fi
    if [ "$credential_role" = "ci" ]; then
      if [ -z "${OPENCLAW_QA_CONVEX_SECRET_CI:-}" ]; then
        echo "Missing required env for Convex ci credential mode: OPENCLAW_QA_CONVEX_SECRET_CI" >&2
        exit 1
      fi
      return 0
    fi
    if [ "$credential_role" = "maintainer" ]; then
      if [ -z "${OPENCLAW_QA_CONVEX_SECRET_MAINTAINER:-}" ]; then
        echo "Missing required env for Convex maintainer credential mode: OPENCLAW_QA_CONVEX_SECRET_MAINTAINER" >&2
        exit 1
      fi
      return 0
    fi
    if [ -z "${OPENCLAW_QA_CONVEX_SECRET_CI:-}" ] && [ -z "${OPENCLAW_QA_CONVEX_SECRET_MAINTAINER:-}" ]; then
      echo "Missing required env for Convex credential mode: OPENCLAW_QA_CONVEX_SECRET_CI or OPENCLAW_QA_CONVEX_SECRET_MAINTAINER" >&2
      exit 1
    fi
    return 0
  fi

  local missing=()
  for key in \
    OPENCLAW_QA_TELEGRAM_GROUP_ID \
    OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN \
    OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN; do
    if [ -z "${!key:-}" ]; then
      missing+=("$key")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    {
      echo "Missing required Telegram QA credential env before Docker work: ${missing[*]}"
      echo "Use one of:"
      echo "  direct Telegram env: OPENCLAW_QA_TELEGRAM_GROUP_ID, OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN, OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"
      echo "  Convex env: OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE=convex plus OPENCLAW_QA_CONVEX_SITE_URL and a role secret"
    } >&2
    exit 1
  fi
}

validate_credential_preflight

docker_e2e_build_or_reuse "$IMAGE_NAME" npm-telegram-live "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

mkdir -p "$ROOT_DIR/.artifacts/qa-e2e"
mkdir -p "$OUTPUT_DIR_HOST"
npm_prefix_host="$(mktemp -d "$ROOT_DIR/.artifacts/qa-e2e/npm-telegram-live-prefix.XXXXXX")"
harness_root="$(mktemp -d "$ROOT_DIR/.artifacts/qa-e2e/npm-telegram-live-harness.XXXXXX")"
harness_package_json="$harness_root/package.json"
cp "$ROOT_DIR/package.json" "$harness_package_json"
node --import tsx "$ROOT_DIR/scripts/e2e/lib/npm-telegram-live/prepare-package.mts" "$harness_package_json"
cleanup() {
  local rc=$?
  trap - EXIT
  printf 'schema=1\nexit_code=%s\nlive_output=job_log\n' "$rc" > "$OUTPUT_DIR_HOST/run-metadata.txt"
  rm -rf "$npm_prefix_host"
  rm -rf "$harness_root"
  exit "$rc"
}
trap cleanup EXIT

docker_env=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_E2E_COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}"
  -e TMPDIR=/tmp
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="$PACKAGE_SPEC"
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL="$PACKAGE_LABEL"
  -e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER_RELATIVE"
  -e OPENCLAW_QA_PACKAGE_SOURCE="$package_install_source"
  -e OPENCLAW_QA_PACKAGE_SOURCE_KIND="$package_source_kind"
  -e OPENCLAW_QA_RUNNER="${OPENCLAW_QA_RUNNER:-docker}"
  -e OPENCLAW_NPM_TELEGRAM_FAST="${OPENCLAW_NPM_TELEGRAM_FAST:-1}"
)

forward_env_if_set() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    docker_env+=(-e "$key")
  fi
}

if [ -n "$credential_source" ]; then
  docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")
fi
if [ -n "$credential_role" ]; then
  docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")
fi
if [ -n "$resolved_prepublish_plugin_registry_dir" ]; then
  docker_env+=(
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry
    -e OPENCLAW_DOCKER_E2E_SELECTED_SHA="${OPENCLAW_DOCKER_E2E_SELECTED_SHA:?missing selected SHA}"
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}"
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:?missing manifest SHA-256}"
  )
fi

for key in \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY \
  GEMINI_API_KEY \
  GOOGLE_API_KEY \
  OPENCLAW_LIVE_OPENAI_KEY \
  OPENCLAW_LIVE_ANTHROPIC_KEY \
  OPENCLAW_LIVE_GEMINI_KEY \
  OPENCLAW_QA_TELEGRAM_GROUP_ID \
  OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN \
  OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN \
  OPENCLAW_QA_CONVEX_SITE_URL \
  OPENCLAW_QA_CONVEX_SECRET_CI \
  OPENCLAW_QA_CONVEX_SECRET_MAINTAINER \
  OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS \
  OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS \
  OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS \
  OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS \
  OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX \
  OPENCLAW_QA_CREDENTIAL_OWNER_ID \
  OPENCLAW_QA_ALLOW_INSECURE_HTTP \
  OPENCLAW_QA_REDACT_PUBLIC_METADATA \
  OPENCLAW_QA_PACKAGE_SOURCE_SHA \
  OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS \
  OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS \
  OPENCLAW_QA_SUITE_PROGRESS \
  OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE \
  OPENCLAW_NPM_TELEGRAM_MODEL \
  OPENCLAW_NPM_TELEGRAM_ALT_MODEL \
  OPENCLAW_NPM_TELEGRAM_SCENARIOS \
  OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES \
  OPENCLAW_NPM_TELEGRAM_RTT_CHECKS \
  OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS \
  OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES \
  OPENCLAW_NPM_TELEGRAM_SKIP_HOTPATH \
  OPENCLAW_NPM_TELEGRAM_SUT_ACCOUNT \
  OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES \
  OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS; do
  forward_env_if_set "$key"
done

echo "Running package Telegram live Docker E2E ($PACKAGE_LABEL)..."
run_logged_print_heartbeat "npm-telegram-package-install" 60 docker_e2e_docker_run_cmd run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" \
  -e OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE="$package_install_source" \
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL="$PACKAGE_LABEL" \
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_SET="$([ -n "$resolved_package_dir" ] && printf 1 || printf 0)" \
  ${package_mount_args[@]+"${package_mount_args[@]}"} \
  ${registry_helper_mount_args[@]+"${registry_helper_mount_args[@]}"} \
  -v "$npm_prefix_host:/npm-global" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-npm-telegram-install.XXXXXX")"
export NPM_CONFIG_PREFIX="/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

install_source="${OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE:?missing OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE}"
package_label="${OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL:-$install_source}"
echo "Installing ${package_label} from ${install_source}..."

registry_pid=""
registry_log=""
cleanup_registry() {
  if [ -n "$registry_pid" ]; then
    kill "$registry_pid" >/dev/null 2>&1 || true
    wait "$registry_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$registry_log" ]; then
    rm -f "$registry_log"
  fi
}
trap cleanup_registry EXIT

if [ "${OPENCLAW_NPM_TELEGRAM_PACKAGE_SET:-0}" = "1" ]; then
  shopt -s nullglob
  package_tgzs=(/package-under-test/*.tgz)
  shopt -u nullglob
  if [ "${#package_tgzs[@]}" -eq 0 ]; then
    echo "prepared package set contains no tgz files" >&2
    exit 1
  fi
  registry_args=()
  for package_tgz in "${package_tgzs[@]}"; do
    package_metadata="$(
      tar -xOf "$package_tgz" package/package.json |
        node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const pkg = JSON.parse(raw);
  if (typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package tarball is missing name or version");
  }
  process.stdout.write(`${pkg.name}\n${pkg.version}\n`);
});
'
    )"
    mapfile -t package_fields <<<"$package_metadata"
    registry_args+=("${package_fields[0]}" "${package_fields[1]}" "$package_tgz")
  done
  registry_port_file="$(mktemp)"
  registry_log="$(mktemp)"
  OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
    node /tmp/openclaw-e2e/lib/plugins/npm-registry-server.mjs \
    "$registry_port_file" \
    "${registry_args[@]}" >"$registry_log" 2>&1 &
  registry_pid=$!
  for _ in $(seq 1 100); do
    if [ -s "$registry_port_file" ]; then
      break
    fi
    if ! kill -0 "$registry_pid" >/dev/null 2>&1; then
      cat "$registry_log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if [ ! -s "$registry_port_file" ]; then
    cat "$registry_log" >&2
    echo "prepared package registry did not start" >&2
    exit 1
  fi
  registry_url="http://127.0.0.1:$(cat "$registry_port_file")"
  rm -f "$registry_port_file"
  export NPM_CONFIG_REGISTRY="$registry_url"
  export npm_config_registry="$registry_url"
fi

npm_install_timeout="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"
run_npm_install() {
  if [ -z "$npm_install_timeout" ] || [ "$npm_install_timeout" = "0" ]; then
    npm install -g "$install_source" --no-fund --no-audit
    return
  fi

  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi
  if [ -z "$timeout_bin" ]; then
    echo "timeout or gtimeout is required for OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$npm_install_timeout" >&2
    return 127
  fi

  if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
    "$timeout_bin" --kill-after=30s "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit
  else
    "$timeout_bin" "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit
  fi
}
run_npm_install

command -v openclaw
openclaw --version
EOF

# Mount the trusted current-source QA harness separately from the installed
# package candidate. The candidate remains the absolute CLI/runtime SUT.
run_logged_print_heartbeat "npm-telegram-live-suite" 60 docker_e2e_run_with_harness \
  "${docker_env[@]}" \
  -v "$ROOT_DIR/.artifacts:/app/.artifacts" \
  -v "$OUTPUT_DIR_HOST:$OUTPUT_DIR_CONTAINER" \
  -v "$harness_package_json:/app/package.json:ro" \
  -v "$ROOT_DIR/dist:/app/dist:ro" \
  -v "$ROOT_DIR/node_modules:/trusted-harness/node_modules:ro" \
  -v "$ROOT_DIR/packages:/app/packages:ro" \
  -v "$ROOT_DIR/extensions:/app/extensions:ro" \
  -v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro" \
  -v "$ROOT_DIR/qa/scenarios:/app/qa/scenarios:ro" \
  -v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro" \
  ${prepublish_registry_mount_args[@]+"${prepublish_registry_mount_args[@]}"} \
  -v "$npm_prefix_host:/npm-global" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh

runtime_home="$(mktemp -d "/tmp/openclaw-npm-telegram-runtime.XXXXXX")"
export HOME="$runtime_home"
export NPM_CONFIG_PREFIX="/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NPM_TELEGRAM_REPO_ROOT="/app"
export OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION="$(node -e 'const pkg = require("/npm-global/lib/node_modules/openclaw/package.json"); process.stdout.write(pkg.version)')"
sut_command="/npm-global/bin/openclaw"
plugin_registry_pid=""

cleanup_recovery() {
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
}
trap cleanup_recovery EXIT

dump_hotpath_logs() {
  local status="$1"
  echo "installed-package onboarding recovery hot path failed with exit code $status" >&2
  for file in \
    /tmp/openclaw-npm-telegram-onboard.json \
    /tmp/openclaw-npm-telegram-codex-install.log \
    /tmp/openclaw-npm-telegram-channel-add.log \
    /tmp/openclaw-npm-telegram-doctor-fix.log \
    /tmp/openclaw-npm-telegram-doctor-check.log \
    /tmp/openclaw-npm-telegram-plugin-registry/server.log; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      openclaw_e2e_print_log "$file" >&2
    fi
  done
}
trap 'status=$?; dump_hotpath_logs "$status"; exit "$status"' ERR

test -x "$sut_command"
openclaw_e2e_run_command "$sut_command" --version
mkdir -p /app/node_modules
link_harness_dependency() {
  local source="$1"
  local name="$2"
  local target="/app/node_modules/$name"
  mkdir -p "$(dirname "$target")"
  ln -sfnT "$source" "$target"
}

# External dependencies resolve from the trusted install, not the candidate.
for dependency_dir in /trusted-harness/node_modules/* /trusted-harness/node_modules/.[!.]*; do
  [ -e "$dependency_dir" ] || continue
  dependency_name="$(basename "$dependency_dir")"
  case "$dependency_name" in
    .bin | openclaw)
      continue
      ;;
    @*)
      [ -d "$dependency_dir" ] || continue
      for scoped_dependency_dir in "$dependency_dir"/*; do
        [ -e "$scoped_dependency_dir" ] || continue
        scoped_dependency_name="$(basename "$scoped_dependency_dir")"
        link_harness_dependency \
          "$scoped_dependency_dir" \
          "$dependency_name/$scoped_dependency_name"
      done
      ;;
    *)
      link_harness_dependency "$dependency_dir" "$dependency_name"
      ;;
  esac
done

# Workspace links must resolve under /app even when pnpm linked them relative to
# the checkout path used by the workflow.
for workspace_dir in /app/packages/* /app/extensions/*; do
  [ -f "$workspace_dir/package.json" ] || continue
  workspace_name="$(node -e \
    'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.name || "");' \
    "$workspace_dir/package.json")"
  [ -n "$workspace_name" ] || continue
  link_harness_dependency "$workspace_dir" "$workspace_name"
done
link_harness_dependency /app openclaw

if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGES_JSON='["@openclaw/codex"]' \
    openclaw_prepublish_plugin_registry_start \
    "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR" \
    "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:?missing selected SHA}" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:?missing manifest SHA-256}" \
    /tmp/openclaw-npm-telegram-plugin-registry \
    plugin_registry_pid
fi

if [ "${OPENCLAW_NPM_TELEGRAM_SKIP_HOTPATH:-0}" != "1" ]; then
  hotpath_home="$(mktemp -d "/tmp/openclaw-npm-telegram-hotpath.XXXXXX")"
  export HOME="$hotpath_home"
  echo "Running installed-package onboarding recovery hot path..."
  hotpath_placeholder="openclaw-npm-telegram-hotpath"
  hotpath_model_value="$(printf '%s%s' s "k-$hotpath_placeholder")"
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    hotpath_model_value="$OPENAI_API_KEY"
  fi
  hotpath_channel_value="$(printf '%s:%s' 123456 "$hotpath_placeholder")"
  # Non-interactive onboarding cannot approve plugin capabilities. This release
  # harness explicitly accepts the staged Codex artifact before testing setup.
  openclaw_e2e_run_command "$sut_command" plugins install @openclaw/codex \
    --accept-capabilities >/tmp/openclaw-npm-telegram-codex-install.log 2>&1 </dev/null
  OPENAI_API_KEY="$hotpath_model_value" openclaw_e2e_run_command "$sut_command" onboard \
    --non-interactive --accept-risk \
    --mode local \
    --auth-choice openai-api-key \
    --secret-input-mode ref \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --skip-daemon \
    --skip-ui \
    --skip-skills \
    --skip-health \
    --json >/tmp/openclaw-npm-telegram-onboard.json </dev/null

  openclaw_e2e_run_command "$sut_command" channels add --channel telegram --token "$hotpath_channel_value" >/tmp/openclaw-npm-telegram-channel-add.log 2>&1 </dev/null
  openclaw_e2e_run_command "$sut_command" doctor --fix --non-interactive >/tmp/openclaw-npm-telegram-doctor-fix.log 2>&1 </dev/null
  openclaw_e2e_run_command "$sut_command" doctor --non-interactive >/tmp/openclaw-npm-telegram-doctor-check.log 2>&1 </dev/null
  export HOME="$runtime_home"
fi

export OPENCLAW_NPM_TELEGRAM_SUT_COMMAND="$sut_command"
trap - ERR
tsx scripts/e2e/npm-telegram-live-runner.ts
EOF

echo "package Telegram live Docker E2E passed ($PACKAGE_LABEL)"
