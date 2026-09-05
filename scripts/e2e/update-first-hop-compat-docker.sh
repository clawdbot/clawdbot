#!/usr/bin/env bash
# Proves an affected packaged updater can install the bridge release and then advance again.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

if [ "${OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP:-0}" != "1" ]; then
  echo "blocked destructive package self-update; set OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 to run" >&2
  exit 2
fi

IMAGE_NAME="$(
  docker_e2e_resolve_image \
    "openclaw-update-first-hop-compat-e2e" \
    OPENCLAW_UPDATE_FIRST_HOP_E2E_IMAGE
)"
SKIP_BUILD="${OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD:-0}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_UPDATE_FIRST_HOP_DOCKER_RUN_TIMEOUT:-1200s}"
ARTIFACT_DIR="${OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/update-first-hop-compat}"
SOURCE_PACKAGE="${OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ:-}"
EXPECTED_MISSING_CHUNK="${OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK:-shared-Y6bNiw2w.js}"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-update-first-hop.XXXXXX")"
PACKAGE_TGZ=""

cleanup() {
  local exit_status="$?"
  trap - EXIT
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  rm -rf "$FIXTURE_ROOT"
  exit "$exit_status"
}
trap cleanup EXIT

mkdir -p "$ARTIFACT_DIR" "$FIXTURE_ROOT/source" "$FIXTURE_ROOT/packages"
chmod -R a+rwX "$ARTIFACT_DIR" || true

if [ -z "$SOURCE_PACKAGE" ]; then
  npm pack openclaw@2026.8.2 \
    --ignore-scripts \
    --json \
    --min-release-age=0 \
    --pack-destination "$FIXTURE_ROOT/source" \
    >"$ARTIFACT_DIR/source-pack.json"
  SOURCE_PACKAGE="$FIXTURE_ROOT/source/$(
    node -e '
      const fs = require("node:fs");
      const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!Array.isArray(result) || result.length !== 1 || !result[0]?.filename) process.exit(1);
      process.stdout.write(result[0].filename);
    ' "$ARTIFACT_DIR/source-pack.json"
  )"
fi
if [ ! -f "$SOURCE_PACKAGE" ]; then
  echo "source package tarball does not exist: $SOURCE_PACKAGE" >&2
  exit 2
fi

PACKAGE_TGZ="$(
  docker_e2e_prepare_package_tgz \
    update-first-hop-compat \
    "${OPENCLAW_UPDATE_FIRST_HOP_CANDIDATE_PACKAGE_TGZ:-}"
)"
docker_e2e_package_mount_args "$PACKAGE_TGZ" /tmp/openclaw-update-first-hop-candidate.tgz

mkdir -p "$FIXTURE_ROOT/packages/negative" "$FIXTURE_ROOT/packages/future"
tar -xzf "$PACKAGE_TGZ" -C "$FIXTURE_ROOT/packages/negative"
tar -xzf "$PACKAGE_TGZ" -C "$FIXTURE_ROOT/packages/future"
node "$ROOT_DIR/scripts/e2e/lib/update-first-hop-package-fixtures.mjs" \
  negative "$FIXTURE_ROOT/packages/negative/package"
node "$ROOT_DIR/scripts/e2e/lib/update-first-hop-package-fixtures.mjs" \
  future "$FIXTURE_ROOT/packages/future/package"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$FIXTURE_ROOT/negative.tgz" \
  -C "$FIXTURE_ROOT/packages/negative" package
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$FIXTURE_ROOT/future.tgz" \
  -C "$FIXTURE_ROOT/packages/future" package

{
  printf 'source=%s\n' "$SOURCE_PACKAGE"
  printf 'candidate=%s\n' "$PACKAGE_TGZ"
  printf 'expected_missing_chunk=%s\n' "$EXPECTED_MISSING_CHUNK"
  shasum -a 256 \
    "$SOURCE_PACKAGE" \
    "$PACKAGE_TGZ" \
    "$FIXTURE_ROOT/negative.tgz" \
    "$FIXTURE_ROOT/future.tgz"
  printf '\nsource_build_info=' && tar -xOf "$SOURCE_PACKAGE" package/dist/build-info.json
  printf '\ncandidate_build_info=' && tar -xOf "$PACKAGE_TGZ" package/dist/build-info.json
  printf '\nfuture_build_info=' && tar -xOf "$FIXTURE_ROOT/future.tgz" package/dist/build-info.json
} >"$ARTIFACT_DIR/inputs.txt"

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  update-first-hop-compat \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  bare \
  "$SKIP_BUILD"

echo "Running packaged updater first-hop compatibility Docker E2E..."
docker_e2e_run_with_harness \
  -e OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 \
  -e OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR=/tmp/openclaw-update-first-hop-artifacts \
  -e OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK="$EXPECTED_MISSING_CHUNK" \
  -v "$ARTIFACT_DIR:/tmp/openclaw-update-first-hop-artifacts" \
  -v "$(docker_e2e_abs_path "$SOURCE_PACKAGE"):/tmp/openclaw-update-first-hop-source.tgz:ro" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -v "$FIXTURE_ROOT/negative.tgz:/tmp/openclaw-update-first-hop-negative.tgz:ro" \
  -v "$FIXTURE_ROOT/future.tgz:/tmp/openclaw-update-first-hop-future.tgz:ro" \
  "$IMAGE_NAME" \
  timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" \
  bash scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh
