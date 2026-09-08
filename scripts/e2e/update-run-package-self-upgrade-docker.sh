#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Proves a published package can update itself through Gateway update.run and restart healthy.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$ROOT_DIR/scripts/lib/upgrade-survivor-diagnostics.sh"
HARNESS_ROOT_DIR="$ROOT_DIR"
LANE_ARTIFACT_SUFFIX=update-run-package-self-upgrade

ALLOW_ENV="OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF"
SOURCE_VERSION="2026.4.26"
SOURCE_TAG="v$SOURCE_VERSION"
SOURCE_COMMIT="be8c24633aaa7ef0425ae1178f096ee8dd6226c0"

if [ "${OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF:-0}" != "1" ]; then
  echo "blocked destructive package self-upgrade; set $ALLOW_ENV=1 to run" >&2
  exit 2
fi

IMAGE_NAME="$(
  docker_e2e_resolve_image \
    "openclaw-update-run-package-self-upgrade-e2e" \
    OPENCLAW_UPDATE_RUN_SELF_UPGRADE_E2E_IMAGE
)"
SKIP_BUILD="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_E2E_SKIP_BUILD:-0}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_DOCKER_RUN_TIMEOUT:-1800s}"
ARTIFACT_DIR="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/update-run-package-self-upgrade}"
QA_CHANNEL_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-update-run-qa-channel.XXXXXX")"
HISTORICAL_DIST_ARCHIVE="$QA_CHANNEL_FIXTURE_ROOT/historical-dist.tar"

run_completed=0
diagnostics_ready=0
cleanup() {
  local exit_status="$?"
  trap - EXIT
  set +e
  # A joined successful scenario, not teardown, owns the success result.
  if [ "$exit_status" -eq 0 ] && [ "$run_completed" != 1 ]; then
    exit_status=1
  fi
  if [ "$exit_status" -ne 0 ] && [ "$diagnostics_ready" = 1 ]; then
    publish_diagnostics || echo "Self-upgrade diagnostics missing; preserving original failure." >&2
  fi
  rm -rf "$QA_CHANNEL_FIXTURE_ROOT"
  exit "$exit_status"
}
trap cleanup EXIT

prepare_qa_channel_fixture() {
  local source_repo="$ROOT_DIR"
  local source_ref="$SOURCE_COMMIT"
  local clone_root=""
  local resolved_commit=""
  local tag_commit=""
  local tag_object=""

  if ! git -C "$source_repo" cat-file -e "$SOURCE_COMMIT^{commit}" 2>/dev/null || \
    ! git -C "$source_repo" cat-file -e "$SOURCE_TAG^{commit}" 2>/dev/null; then
    clone_root="$QA_CHANNEL_FIXTURE_ROOT/source"
    git clone \
      --depth=1 \
      --filter=blob:none \
      --single-branch \
      --branch "$SOURCE_TAG" \
      https://github.com/openclaw/openclaw.git \
      "$clone_root"
    source_repo="$clone_root"
    source_ref="HEAD"
  fi

  resolved_commit="$(git -C "$source_repo" rev-parse "$source_ref^{commit}")"
  tag_commit="$(git -C "$source_repo" rev-parse "$SOURCE_TAG^{commit}")"
  tag_object="$(git -C "$source_repo" rev-parse "$SOURCE_TAG")"
  if [ "$resolved_commit" != "$SOURCE_COMMIT" ] || [ "$tag_commit" != "$SOURCE_COMMIT" ]; then
    echo "$SOURCE_TAG/source fixture resolved to unexpected commits: tag=$tag_commit source=$resolved_commit" >&2
    return 1
  fi
  SOURCE_TAG="$SOURCE_TAG" \
    SOURCE_COMMIT="$SOURCE_COMMIT" \
    TAG_OBJECT="$tag_object" \
    node -e '
      const fs = require("node:fs");
      fs.writeFileSync(
        process.argv[1],
        `${JSON.stringify({
          tag: process.env.SOURCE_TAG,
          tagObject: process.env.TAG_OBJECT,
          commit: process.env.SOURCE_COMMIT,
          buildCommand: "OPENCLAW_BUILD_PRIVATE_QA=1 corepack pnpm build:docker",
          runtimeInstall: `npm install --prefix <isolated-root> --omit=dev openclaw@${process.env.SOURCE_TAG.slice(1)}`,
          privateDistOverlay: true,
        }, null, 2)}\n`,
      );
    ' "$ARTIFACT_DIR/qa-channel-fixture-provenance.json"

  local checkout_root="$QA_CHANNEL_FIXTURE_ROOT/checkout"
  mkdir -p "$checkout_root"
  git -C "$source_repo" archive "$source_ref" | tar -x -C "$checkout_root"

  local package_json="$checkout_root/extensions/qa-channel/package.json"
  local fixture_version
  fixture_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$package_json")"
  if [ "$fixture_version" != "2026.4.25" ]; then
    echo "historical QA channel fixture version mismatch: expected 2026.4.25, got $fixture_version" >&2
    return 1
  fi

  echo "Building the tagged QA channel with the shipped Docker build" | tee "$ARTIFACT_DIR/historical-qa-channel-build.log"
  (
    cd "$checkout_root"
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 OPENCLAW_BUILD_PRIVATE_QA=1 corepack pnpm build:docker
  ) >>"$ARTIFACT_DIR/historical-qa-channel-build.log" 2>&1

  local compiled_plugin="$checkout_root/dist/extensions/qa-channel"
  for required_file in package.json openclaw.plugin.json index.js setup-entry.js; do
    if [ ! -f "$compiled_plugin/$required_file" ]; then
      echo "shipped build omitted QA channel artifact $required_file" >&2
      return 1
    fi
  done
  tar -C "$checkout_root" -cf "$HISTORICAL_DIST_ARCHIVE" dist
}

mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true
prepare_diagnostics_capture
prepare_qa_channel_fixture

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  update-run-package-self-upgrade \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  bare \
  "$SKIP_BUILD"

echo "Running Gateway update.run package self-upgrade Docker E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF=1 \
  -e OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR=/tmp/openclaw-update-run-artifacts \
  -e OPENCLAW_UPDATE_RUN_SELF_UPGRADE_SOURCE_VERSION="$SOURCE_VERSION" \
  -v "$ARTIFACT_DIR:/tmp/openclaw-update-run-artifacts" \
  -v "$HISTORICAL_DIST_ARCHIVE:/tmp/openclaw-update-run-historical-dist.tar:ro" \
  "$IMAGE_NAME" \
  timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" \
  bash -lc 'set -euo pipefail
historical_install_root=/tmp/openclaw-update-run-historical-install
historical_package_root="$historical_install_root/node_modules/openclaw"
qa_plugin_link=/tmp/openclaw-update-run-build/dist/extensions/qa-channel
npm install \
  --prefix "$historical_install_root" \
  --omit=dev \
  --no-fund \
  --no-audit \
  "openclaw@$OPENCLAW_UPDATE_RUN_SELF_UPGRADE_SOURCE_VERSION" \
  2>&1 | tee /tmp/openclaw-update-run-artifacts/historical-package-install.log
tar --no-same-owner \
  -xf /tmp/openclaw-update-run-historical-dist.tar \
  -C "$historical_package_root"
mkdir -p "$(dirname "$qa_plugin_link")"
ln -s "$historical_package_root/dist/extensions/qa-channel" "$qa_plugin_link"
HISTORICAL_PACKAGE_ROOT="$historical_package_root" \
  HISTORICAL_PLUGIN_ENTRY="$historical_package_root/dist/extensions/qa-channel/index.js" \
  HISTORICAL_PREFLIGHT_OUT=/tmp/openclaw-update-run-artifacts/historical-package-preflight.json \
  node --input-type=module <<NODE
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const packageRoot = process.env.HISTORICAL_PACKAGE_ROOT;
const pluginEntry = process.env.HISTORICAL_PLUGIN_ENTRY;
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;
const pluginVersion = JSON.parse(
  fs.readFileSync(path.join(path.dirname(pluginEntry), "package.json"), "utf8"),
).version;
if (packageVersion !== process.env.OPENCLAW_UPDATE_RUN_SELF_UPGRADE_SOURCE_VERSION) {
  throw new Error("isolated historical package version mismatch: " + packageVersion);
}
await import(pathToFileURL(pluginEntry).href);
fs.writeFileSync(
  process.env.HISTORICAL_PREFLIGHT_OUT,
  JSON.stringify({ packageVersion, pluginVersion, pluginEntryImported: true }, null, 2) + "\n",
);
NODE
exec bash scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh'
run_completed=1
