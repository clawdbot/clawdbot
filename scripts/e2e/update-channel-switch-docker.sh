#!/usr/bin/env bash
# Exercises package-to-git and git-to-package update channel switching in Docker.
# Both package and git fixtures are derived from the same prepared npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-update-channel-switch-e2e" OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_SKIP_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz update-channel-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(
  node "$ROOT_DIR/scripts/lib/openclaw-test-state.mjs" shell \
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
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
git_root="/tmp/openclaw-git"
mkdir -p "$git_root"
# Build the fake git install from the packed package contents, not the checkout.
tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
# The package-derived fixture can carry patchedDependencies whose targets are
# absent from the trimmed tarball install; that should not block update preflight.
node scripts/e2e/lib/update-channel-switch/assertions.mjs prepare-git-fixture "$git_root"
(
  cd "$git_root"
  npm install --omit=optional --no-fund --no-audit >/tmp/openclaw-git-install.log 2>&1
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

npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/npm-prefix/lib/node_modules/openclaw/package.json\", \"utf8\")).version")"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

export OPENCLAW_GIT_DIR="$git_root"
export OPENCLAW_UPDATE_DEV_TARGET_REF="$fixture_sha"

echo "==> package -> git dev channel"
set +e
dev_json="$(openclaw update --channel dev --yes --json --no-restart)"
dev_status=$?
set -e
printf "%s\n" "$dev_json"
if [ "$dev_status" -ne 0 ]; then
  exit "$dev_status"
fi
UPDATE_JSON="$dev_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update dev
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
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel stable

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind package

echo "OK"
'
