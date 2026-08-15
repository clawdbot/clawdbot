#!/usr/bin/env bash
# Proves hosted npm installation plus dedicated-prefix source installation.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-cli-installer-distribution:local")"
PACKAGE_TGZ="$(
  docker_e2e_prepare_package_tgz cli-installer-distribution "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
)"
HOSTED_PROOF_CONTAINER="openclaw-hosted-installer-proof-$$"
SOURCE_PROOF_CONTAINER="openclaw-source-installer-proof-$$"
SOURCE_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/openclaw-source.XXXXXX.bundle")"
SOURCE_PROOF_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/openclaw-source-proof.XXXXXX.sh")"
SOURCE_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
SOURCE_MEMORY="${OPENCLAW_CLI_INSTALLER_SOURCE_MEMORY:-16g}"

cleanup() {
  docker_e2e_docker_cmd rm -f \
    "$HOSTED_PROOF_CONTAINER" \
    "$SOURCE_PROOF_CONTAINER" >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  rm -f "$SOURCE_BUNDLE" "$SOURCE_PROOF_SCRIPT"
}
trap cleanup EXIT

git -C "$ROOT_DIR" bundle create "$SOURCE_BUNDLE" HEAD
cat >"$SOURCE_PROOF_SCRIPT" <<'SOURCE_PROOF'
#!/usr/bin/env bash
set -euo pipefail

test -r "$0"
test -x "$0"
command -v curl >/dev/null
git clone -q /tmp/openclaw-source.bundle /tmp/openclaw-source
git -C /tmp/openclaw-source checkout -q --detach "$OPENCLAW_SOURCE_SHA"
bash /tmp/openclaw-source/scripts/install-cli.sh \
  --install-method git \
  --git-dir /tmp/openclaw-source \
  --version "$OPENCLAW_SOURCE_SHA" \
  --no-git-update \
  --prefix /tmp/openclaw-prefix \
  --node-version 24.15.0 \
  --no-onboard

prefix_node=/tmp/openclaw-prefix/tools/node/bin/node
prefix_cli=/tmp/openclaw-prefix/bin/openclaw
test -x "$prefix_node"
test -x "$prefix_cli"
grep -Fq "exec \"$prefix_node\"" "$prefix_cli"
grep -Fq "/tmp/openclaw-source/dist/entry.js" "$prefix_cli"
export PATH="/tmp/openclaw-prefix/bin:$PATH"
test "$(command -v openclaw)" = "$prefix_cli"
test "$(git -C /tmp/openclaw-source rev-parse HEAD)" = "$OPENCLAW_SOURCE_SHA"
openclaw_version="$(openclaw --version)"
openclaw --help >/tmp/openclaw-help
test -s /tmp/openclaw-help
status_json="$(openclaw update status --json)"
STATUS_JSON="$status_json" node -e "
  const status = JSON.parse(process.env.STATUS_JSON);
  if (status.update?.installKind !== \"git\") {
    throw new Error(\`expected git install kind, got \${status.update?.installKind}\`);
  }
"
printf "prefixNode=%s@%s\n" "$prefix_node" "$("$prefix_node" --version)"
printf "prefixOpenClaw=%s@%s\n" "$prefix_cli" "$openclaw_version"
printf "sourceHead=%s installKind=git\n" "$OPENCLAW_SOURCE_SHA"
printf "sourceOnboard=disabled\n"
touch /tmp/openclaw-proof-ready
exec sleep infinity
SOURCE_PROOF
chmod 0555 "$SOURCE_PROOF_SCRIPT"

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  cli-installer-distribution \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  bare

echo "==> Hosted install.sh exact-candidate proof"
docker_e2e_docker_run_cmd run -d \
  --name "$HOSTED_PROOF_CONTAINER" \
  -e HOME=/tmp/openclaw-hosted-home \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -v "$PACKAGE_TGZ:/tmp/openclaw-current.tgz:ro" \
  -v "$ROOT_DIR/scripts/install.sh:/tmp/install.sh:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    mkdir -p "$HOME"
    bash /tmp/install.sh \
      --install-method npm \
      --version file:/tmp/openclaw-current.tgz \
      --no-onboard \
      --no-prompt
    source "$HOME/.bashrc"
    hash -r
    openclaw_path="$(command -v openclaw)"
    test -n "$openclaw_path"
    node_path="$(command -v node)"
    node_version="$(node --version)"
    openclaw_version="$(openclaw --version)"
    openclaw --help >/tmp/openclaw-help
    test -s /tmp/openclaw-help
    printf "hostedNode=%s@%s\n" "$node_path" "$node_version"
    printf "hostedOpenClaw=%s@%s\n" "$openclaw_path" "$openclaw_version"
    printf "hostedOnboard=disabled\n"
    touch /tmp/openclaw-proof-ready
    exec sleep infinity
  ' >/dev/null

# A full source install builds every workspace package; the shared 8g cap OOMs before wrapper creation.
echo "==> install-cli.sh dedicated-prefix source-checkout proof"
docker_e2e_docker_run_cmd run -d \
  --name "$SOURCE_PROOF_CONTAINER" \
  --memory "$SOURCE_MEMORY" \
  -e HOME=/tmp/openclaw-source-home \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_SOURCE_SHA=$SOURCE_SHA" \
  --user root \
  -v "$SOURCE_BUNDLE:/tmp/openclaw-source.bundle:ro" \
  -v "$SOURCE_PROOF_SCRIPT:/tmp/source-proof.sh:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl
    rm -rf /var/lib/apt/lists/*
    command -v curl >/dev/null
    install -d -o appuser -g appuser "$HOME"
    exec runuser -u appuser -- env \
      HOME="$HOME" \
      OPENCLAW_NO_ONBOARD="$OPENCLAW_NO_ONBOARD" \
      OPENCLAW_NO_PROMPT="$OPENCLAW_NO_PROMPT" \
      COREPACK_ENABLE_DOWNLOAD_PROMPT="$COREPACK_ENABLE_DOWNLOAD_PROMPT" \
      OPENCLAW_SOURCE_SHA="$OPENCLAW_SOURCE_SHA" \
      bash /tmp/source-proof.sh
  ' >/dev/null

wait_for_proof() {
  local container_name="$1"
  for _ in $(seq 1 1200); do
    if docker exec "$container_name" test -f /tmp/openclaw-proof-ready; then
      docker logs "$container_name"
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]; then
      docker logs "$container_name" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container_name" >&2
  return 1
}

wait_for_proof "$HOSTED_PROOF_CONTAINER"
wait_for_proof "$SOURCE_PROOF_CONTAINER"
echo "CLI installer distribution proof passed."
