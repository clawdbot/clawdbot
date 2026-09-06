#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/scripts/docker/install-sh-common/version-parse.sh"

PACKAGE_TGZ="${1:?missing package tarball}"
IDENTITY_PATH="${2:?missing identity output path}"
IMAGE_NAME="${3:?missing image name}"
NPM_PROOF_CONTAINER="${4:?missing npm proof container}"
PNPM_PROOF_CONTAINER="${5:?missing pnpm proof container}"
BUN_PROOF_CONTAINER="${6:?missing Bun proof container}"
MUSL_PROOF_CONTAINER="${7:?missing musl proof container}"

read_manifest_version() {
  local container_name="$1"
  local manifest_path="$2"
  docker exec "$container_name" node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error(`missing version in ${process.argv[1]}`);
}
process.stdout.write(manifest.version);
' "$manifest_path"
}

read_bun_proof() {
  local field="$1"
  docker exec "$BUN_PROOF_CONTAINER" node -e '
const fs = require("node:fs");
const proof = JSON.parse(fs.readFileSync("/tmp/openclaw-bun-proof.json", "utf8"));
const value = proof[process.argv[1]];
if (typeof value !== "string" || value.length === 0) {
  throw new Error(`missing Bun proof field ${process.argv[1]}`);
}
process.stdout.write(value);
' "$field"
}

EXPECTED_PACKAGE_VERSION="$(
  tar -xOf "$PACKAGE_TGZ" package/package.json | node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("package artifact manifest is missing version");
}
process.stdout.write(manifest.version);
'
)"

NPM_PACKAGE_ROOT="/usr/local/lib/node_modules/openclaw"
PNPM_PACKAGE_ROOT="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/openclaw-package-root | tr -d '\r\n')"
BUN_PACKAGE_ROOT="$(read_bun_proof installedPackageRoot)"

NPM_PACKAGE_VERSION="$(read_manifest_version "$NPM_PROOF_CONTAINER" "$NPM_PACKAGE_ROOT/package.json")"
PNPM_PACKAGE_VERSION="$(read_manifest_version "$PNPM_PROOF_CONTAINER" "$PNPM_PACKAGE_ROOT/package.json")"
BUN_PACKAGE_VERSION="$(read_bun_proof installedPackageVersion)"

NPM_INSTALLED_VERSION="$(docker exec "$NPM_PROOF_CONTAINER" cat /tmp/openclaw-version | tr -d '\r\n')"
PNPM_INSTALLED_VERSION="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/openclaw-version | tr -d '\r\n')"
BUN_INSTALLED_VERSION="$(read_bun_proof openclawVersion)"
BUN_OPENCLAW_PATH="$(read_bun_proof openclawPath)"

MANAGERS=(npm pnpm bun)
MANIFEST_VERSIONS=("$NPM_PACKAGE_VERSION" "$PNPM_PACKAGE_VERSION" "$BUN_PACKAGE_VERSION")
CLI_OUTPUTS=("$NPM_INSTALLED_VERSION" "$PNPM_INSTALLED_VERSION" "$BUN_INSTALLED_VERSION")
PARSED_VERSIONS=()

for index in "${!MANAGERS[@]}"; do
  manager="${MANAGERS[$index]}"
  manifest_version="${MANIFEST_VERSIONS[$index]}"
  cli_output="${CLI_OUTPUTS[$index]}"
  if [[ "$manifest_version" != "$EXPECTED_PACKAGE_VERSION" ]]; then
    echo "[$manager] installed manifest version '$manifest_version' != artifact '$EXPECTED_PACKAGE_VERSION'" >&2
    exit 1
  fi
  parsed_version="$(extract_openclaw_semver "$cli_output")"
  if [[ "$parsed_version" != "$EXPECTED_PACKAGE_VERSION" ]]; then
    echo "[$manager] CLI output parses to '${parsed_version:-<unparseable>}' (raw: '$cli_output'), expected artifact '$EXPECTED_PACKAGE_VERSION'" >&2
    exit 1
  fi
  PARSED_VERSIONS+=("$parsed_version")
done

node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts" \
  --scenario docker-package-install \
  --output "$IDENTITY_PATH" \
  --image "$IMAGE_NAME" \
  --package "$PACKAGE_TGZ" \
  --container "npm=$NPM_PROOF_CONTAINER" \
  --container "pnpm=$PNPM_PROOF_CONTAINER" \
  --container "bun=$BUN_PROOF_CONTAINER" \
  --container "musl=$MUSL_PROOF_CONTAINER" \
  --detail "npm:installedPackageRoot=$NPM_PACKAGE_ROOT" \
  --detail "npm:installedPackageVersion=$NPM_PACKAGE_VERSION" \
  --detail "npm:openclawVersion=$NPM_INSTALLED_VERSION" \
  --detail "npm:parsedOpenclawVersion=${PARSED_VERSIONS[0]}" \
  --detail "npm:openclawPath=/usr/local/bin/openclaw" \
  --detail "npm:helpCommand=passed" \
  --detail "npm:nonRootExecution=passed" \
  --detail "musl:fsSafeNative=passed" \
  --detail "pnpm:installedPackageRoot=$PNPM_PACKAGE_ROOT" \
  --detail "pnpm:installedPackageVersion=$PNPM_PACKAGE_VERSION" \
  --detail "pnpm:openclawVersion=$PNPM_INSTALLED_VERSION" \
  --detail "pnpm:parsedOpenclawVersion=${PARSED_VERSIONS[1]}" \
  --detail "pnpm:openclawPath=/tmp/pnpm-home/bin/openclaw" \
  --detail "pnpm:helpCommand=passed" \
  --detail "bun:installedPackageRoot=$BUN_PACKAGE_ROOT" \
  --detail "bun:installedPackageVersion=$BUN_PACKAGE_VERSION" \
  --detail "bun:openclawVersion=$BUN_INSTALLED_VERSION" \
  --detail "bun:parsedOpenclawVersion=${PARSED_VERSIONS[2]}" \
  --detail "bun:openclawPath=$BUN_OPENCLAW_PATH" \
  --detail "bun:helpCommand=passed"
