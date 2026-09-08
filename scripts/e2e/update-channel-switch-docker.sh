#!/usr/bin/env bash
# Exercises package-to-git and git-to-package update channel switching in Docker.
# Both package and git fixtures are derived from the same prepared npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-update-channel-switch-e2e" OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_SKIP_BUILD:-0}"
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz update-channel-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(
  node --import tsx "$ROOT_DIR/scripts/lib/openclaw-test-state.mts" shell \
    --label update-channel-switch \
    --scenario update-stable |
    base64 |
    tr -d '\n'
)"

docker_e2e_build_or_reuse "$IMAGE_NAME" update-channel-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running update channel switch E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_FS_SAFE_NATIVE_CONTRACT \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PNPM_HOME=/tmp/pnpm-home
export PATH="/tmp/npm-prefix/bin:/tmp/pnpm-home:$PATH"
export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
git_root="/tmp/openclaw-git"
mkdir -p "$git_root"
# Build the fake git install from the packed package contents, not the checkout.
tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
node scripts/e2e/lib/package-git-fixture.mjs prepare "$git_root"
# The package-derived fixture can carry patchedDependencies whose targets are
# absent from the trimmed tarball install; that should not block update preflight.
node scripts/e2e/lib/update-channel-switch/assertions.mjs prepare-git-fixture "$git_root"
(
  cd "$git_root"
  # Git-style fixtures still need optional native prebuilds; omit only development dependencies.
  if ! openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=dev --no-fund --no-audit >/tmp/openclaw-git-install.log 2>&1; then
    openclaw_e2e_print_log /tmp/openclaw-git-install.log >&2
    exit 1
  fi
)
node scripts/e2e/lib/update-channel-switch/assertions.mjs write-control-ui "$git_root"

git config --global user.email "docker-e2e@openclaw.local"
git config --global user.name "OpenClaw Docker E2E"
git config --global gc.auto 0
git -C "$git_root" init -q
git -C "$git_root" config gc.auto 0
git -C "$git_root" add -A
git -C "$git_root" add -f dist/control-ui/index.html
git -C "$git_root" commit -qm "test fixture"
fixture_sha="$(git -C "$git_root" rev-parse HEAD)"

pkg_tgz_path="$package_tgz"

package_install_log="/tmp/openclaw-update-channel-switch-package-install.log"
if ! openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path" >"$package_install_log" 2>&1; then
  openclaw_e2e_print_log "$package_install_log" >&2
  exit 1
fi
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/npm-prefix/lib/node_modules/openclaw/package.json\", \"utf8\")).version")"
# npm global tarball installs can retain the host platform package even with
# --omit=optional. Relocate any such package so this lane deterministically
# exercises the optional-free JavaScript fallback promised by that install mode.
fs_safe_scope=/tmp/npm-prefix/lib/node_modules/openclaw/node_modules/@openclaw
for platform_package in "$fs_safe_scope"/fs-safe-*; do
  if [ -d "$platform_package" ]; then
    mv "$platform_package" "$platform_package.omitted"
  fi
done
node scripts/docker/verify-fs-safe-native.mjs \
  --package-root /tmp/npm-prefix/lib/node_modules/openclaw \
  --mode fallback
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT
command -v openclaw >/dev/null
openclaw_e2e_enable_openclaw_cli_timeout

registry_port_file=/tmp/openclaw-update-channel-registry.port
registry_log=/tmp/openclaw-update-channel-registry.log
registry_pid=""
cleanup_registry() {
  if [ -n "$registry_pid" ]; then
    kill "$registry_pid" 2>/dev/null || true
    wait "$registry_pid" 2>/dev/null || true
  fi
}
trap cleanup_registry EXIT
rm -f "$registry_port_file"
OPENCLAW_NPM_REGISTRY_DIST_TAGS="latest=0.0.0,beta=$package_version" \
  OPENCLAW_NPM_REGISTRY_UPSTREAM="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL:-https://registry.npmjs.org}" \
  node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$registry_port_file" \
    openclaw \
    "$package_version" \
    "$package_tgz" \
    >"$registry_log" 2>&1 &
registry_pid="$!"
for _ in $(seq 1 100); do
  if [ -s "$registry_port_file" ]; then
    break
  fi
  if ! kill -0 "$registry_pid" 2>/dev/null; then
    openclaw_e2e_print_log "$registry_log" >&2
    exit 1
  fi
  sleep 0.1
done
if [ ! -s "$registry_port_file" ]; then
  openclaw_e2e_print_log "$registry_log" >&2
  echo "Timed out waiting for update-channel npm fixture registry." >&2
  exit 1
fi
export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$registry_port_file")"
export npm_config_registry="$NPM_CONFIG_REGISTRY"

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

export OPENCLAW_GIT_DIR="$git_root"
export OPENCLAW_UPDATE_DEV_TARGET_REF="$fixture_sha"

echo "==> package stable -> package beta channel"
set +e
beta_json="$(openclaw update --channel beta --yes --json --no-restart)"
beta_status=$?
set -e
printf "%s\n" "$beta_json"
if [ "$beta_status" -ne 0 ]; then
  exit "$beta_status"
fi
UPDATE_JSON="$beta_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update beta
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel beta
node scripts/e2e/lib/update-channel-switch/assertions.mjs \
  assert-installed-version \
  /tmp/npm-prefix/lib/node_modules/openclaw \
  "$package_version"

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind package

assert_package_dry_run() {
  local expected_kind="$1" expected_channel="$2"
  shift 2
  local preview
  preview="$(openclaw update --dry-run --json --no-restart "$@")"
  printf "%s\n" "$preview"
  UPDATE_JSON="$preview" node scripts/e2e/lib/update-channel-switch/assertions.mjs \
    assert-dry-run "$expected_kind" "$expected_channel"
  node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel dev
}
dev_channel_args=(--channel dev)
# Legacy package acceptance permits missing channel persistence; keep its explicit switch.
if [ "$OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT" != "1" ]; then
  echo "==> package dry-run channel and one-off tag precedence"
  openclaw config set update.channel dev
  assert_package_dry_run git dev
  assert_package_dry_run git dev --channel dev
  assert_package_dry_run git dev --channel dev --tag beta
  assert_package_dry_run package dev --tag beta
  assert_package_dry_run package stable --channel stable
  dev_channel_args=()
fi

echo "==> ordinary untracked files still block Git admission"
printf "retain user notes\n" >"$git_root/operator-update-notes.tmp"
set +e
dirty_json="$(openclaw update "${dev_channel_args[@]}" --yes --json --no-restart)"
dirty_status=$?
set -e
# Historical update CLIs can report a blocked structured result with exit zero.
# The assertion proves the update was rejected and no checkout state changed.
if [ "$OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT" != "1" ] && [ "$dirty_status" -ne 1 ]; then
  echo "expected current dirty-worktree update to exit 1, got $dirty_status" >&2
  exit 1
fi
UPDATE_JSON="$dirty_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs \
  assert-dirty-update "$git_root" "$fixture_sha"
node -e "require(\"node:fs\").unlinkSync(process.argv[1])" "$git_root/operator-update-notes.tmp"

echo "==> package -> git dev channel"
set +e
dev_json="$(openclaw update "${dev_channel_args[@]}" --yes --json --no-restart)"
dev_status=$?
set -e
printf "%s\n" "$dev_json"
if [ "$dev_status" -ne 0 ]; then
  exit "$dev_status"
fi
UPDATE_JSON="$dev_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update dev
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-runtime-staging-clean "$git_root"
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel dev

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind git

echo "==> git -> package stable channel"
set +e
stable_json="$(openclaw update --channel stable --tag "$pkg_tgz_path" --yes --json --no-restart)"
stable_status=$?
set -e
printf "%s\n" "$stable_json"
if [ "$stable_status" -ne 0 ]; then
  exit "$stable_status"
fi
UPDATE_JSON="$stable_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update stable
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-runtime-staging-clean "$git_root"
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel stable

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind package

echo "OK"
'
