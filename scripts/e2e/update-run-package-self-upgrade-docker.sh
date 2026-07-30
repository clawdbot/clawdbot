#!/usr/bin/env bash
# Proves a published package can update itself through Gateway update.run and restart healthy.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

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

cleanup() {
  rm -rf "$QA_CHANNEL_FIXTURE_ROOT"
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
}

mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true
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
  -v "$QA_CHANNEL_FIXTURE_ROOT/checkout:/tmp/openclaw-update-run-build:ro" \
  "$IMAGE_NAME" \
  timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" \
  bash scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh
