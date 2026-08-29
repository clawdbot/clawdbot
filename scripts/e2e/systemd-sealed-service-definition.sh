#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image \
  "openclaw-systemd-sealed-service-definition-e2e" \
  OPENCLAW_SYSTEMD_SEALED_SERVICE_DEFINITION_E2E_IMAGE)"

docker_e2e_build_or_reuse "$IMAGE_NAME" systemd-sealed-service-definition

echo "Proving root-owned systemd service definitions reject unprivileged installation without writes..."
docker_e2e_run_with_harness -i --user root "$IMAGE_NAME" bash -s <<'SCENARIO'
set -euo pipefail

service_home=/home/appuser
state_dir="$service_home/.openclaw"
unit_dir="$service_home/.config/systemd/user"
unit_path="$unit_dir/openclaw-gateway.service"
environment_path="$state_dir/gateway.systemd.env"
config_path="$state_dir/openclaw.json"
shim_dir=/tmp/openclaw-sealed-systemd-bin
token_canary=sealed-docker-proof-token

[[ "$(id -u)" == 0 && "$(runuser -u appuser -- id -u)" != 0 ]] || {
  echo "The fixture requires root setup and an unprivileged appuser." >&2
  exit 1
}
install -d -o appuser -g appuser -m 0755 "$service_home/.config" "$service_home/.config/systemd"
install -d -o appuser -g appuser -m 0700 "$state_dir"
install -d -o root -g root -m 0555 "$unit_dir"
install -d -o root -g root -m 0755 "$shim_dir"
install -o root -g root -m 0755 scripts/e2e/lib/doctor-install-switch/shims/systemctl "$shim_dir/systemctl"
install -o root -g root -m 0755 scripts/e2e/lib/doctor-install-switch/shims/busctl "$shim_dir/busctl"
install -o root -g root -m 0644 scripts/e2e/lib/doctor-install-switch/shims/systemd-exec-start.mjs "$shim_dir/systemd-exec-start.mjs"

install_sealed_unit() {
  install -o root -g "$1" -m "$2" /dev/stdin "$unit_path" <<'UNIT'
[Unit]
Description=OpenClaw Gateway (umbreon-latest sealed ownership proof)
[Service]
ExecStart=/usr/local/bin/node /app/openclaw.mjs gateway --port 18789
WorkingDirectory=/app
Environment=OPENCLAW_GATEWAY_PORT=18789
EnvironmentFile=/home/appuser/.openclaw/gateway.systemd.env
[Install]
WantedBy=default.target
UNIT
}

install_sealed_unit root 0444
printf '%s\n' 'OPENCLAW_SEALED_DOCKER_PROOF=from-state-dotenv' |
  install -o appuser -g appuser -m 0600 /dev/stdin "$state_dir/.env"
printf '%s\n' 'OPENCLAW_SEALED_DOCKER_PROOF=preserve-original-generated-environment' |
  install -o appuser -g appuser -m 0600 /dev/stdin "$environment_path"

snapshot_managed_state() {
  stat -c '%n:%u:%g:%a:%i' "$unit_dir" "$state_dir" "$unit_path" "$environment_path" "$state_dir/.env"
  sha256sum "$unit_path" "$environment_path" "$state_dir/.env"
  if [[ -e "$config_path" ]]; then
    stat -c '%n:%u:%g:%a:%i' "$config_path"
    sha256sum "$config_path"
  else
    printf 'config=absent\n'
  fi
  find "$unit_dir" -mindepth 1 -maxdepth 1 -printf 'unit-entry=%f\n' | sort
  find "$state_dir" -mindepth 1 -maxdepth 1 ! -name state -printf 'state-entry=%f\n' | sort
}

for scenario in missing-mode missing-token missing-config group-writable-root-owned; do
  case "$scenario" in
    missing-mode) config='{"gateway":{"port":18789,"auth":{"mode":"token","token":"sealed-docker-proof-token"}}}' ;;
    missing-token) config='{"gateway":{"mode":"local","port":18789,"auth":{"mode":"token"}}}' ;;
    missing-config) config='' ;;
    group-writable-root-owned)
      rm -f "$unit_path"
      rmdir "$unit_dir"
      install -d -o appuser -g appuser -m 0755 "$unit_dir"
      install_sealed_unit appuser 0664
      runuser -u appuser -- test -w "$unit_dir"
      runuser -u appuser -- test -w "$unit_path"
      config='{"gateway":{"mode":"local","port":18789,"auth":{"mode":"token","token":"sealed-docker-proof-token"}}}'
      ;;
  esac
  if [[ -n "$config" ]]; then
    printf '%s\n' "$config" | install -o appuser -g appuser -m 0600 /dev/stdin "$config_path"
  else
    rm -f "$config_path"
  fi

  state_before="$(snapshot_managed_state)"
  install_result=0
  output="$(runuser -u appuser -- env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD \
    HOME="$service_home" USER=appuser LOGNAME=appuser PATH="$shim_dir:$PATH" \
    OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" \
    node /app/openclaw.mjs gateway install --force --json 2>&1)" || install_result=$?

  if [[ "$install_result" == 0 || "$output" != *SERVICE_DEFINITION_SEALED* ||
    "$output" != *"privileged deployment owner"* || "$output" == *"$token_canary"* ]]; then
    echo "Unprivileged sealed service install did not fail safely ($scenario)." >&2
    exit 1
  fi
  if [[ "$state_before" != "$(snapshot_managed_state)" ]]; then
    echo "Sealed service install changed protected bytes, metadata, or directory entries ($scenario)." >&2
    exit 1
  fi
  echo "Sealed systemd ownership proof passed without writes ($scenario)."
done
SCENARIO

# File mounts need SYS_ADMIN only inside this disposable fixture. Feed the helper
# over stdin: no host paths, private data, or Docker socket enter this container.
# Docker tmpfs defaults to noexec; only the fixture's shim directory needs execution.
file_mount_cid_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-file-mount-cid.XXXXXX")"
trap 'docker_e2e_cleanup_container_cidfile "$file_mount_cid_dir/container.cid"; rm -rf "$file_mount_cid_dir"' EXIT
docker_e2e_docker_run_cmd run --rm -i --cidfile "$file_mount_cid_dir/container.cid" \
  --network none --read-only --tmpfs /tmp:rw,mode=1777 --tmpfs /home/appuser:rw \
  --tmpfs /tmp/openclaw-file-mount/bin:rw,exec,mode=0755 \
  --cap-drop ALL --cap-add SYS_ADMIN --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --cap-add SETUID --cap-add SETGID --security-opt seccomp=unconfined \
  --security-opt no-new-privileges --user 0 --entrypoint node "$IMAGE_NAME" --input-type=module \
  <"$ROOT_DIR/scripts/e2e/lib/systemd-sealed-service-definition/file-mount.mjs"
docker_e2e_cleanup_container_cidfile "$file_mount_cid_dir/container.cid"
rmdir "$file_mount_cid_dir"
trap - EXIT

mount_fixture="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-systemd-mounts.XXXXXX")"
trap 'rm -rf "$mount_fixture"' EXIT
for release in "$mount_fixture/releases/selected" "$mount_fixture/unrelated" "$mount_fixture/openclaw"; do
  mkdir -p "$release/dist"
  printf '%s\n' '{"name":"openclaw"}' >"$release/package.json"
  printf '%s\n' '// inert release fixture' >"$release/dist/index.js"
done
for relationship in same different; do
  current_source="$mount_fixture/releases/selected"
  if [[ "$relationship" == different ]]; then
    current_source="$mount_fixture/unrelated"
  fi
  docker_e2e_run_with_harness --network none --user appuser \
    --mount "type=bind,src=$mount_fixture/openclaw,dst=/proof/openclaw,readonly" \
    --mount "type=bind,src=$mount_fixture/releases,dst=/proof/releases,readonly" \
    --mount "type=bind,src=$current_source,dst=/proof/current,readonly" \
    "$IMAGE_NAME" node scripts/e2e/lib/systemd-sealed-service-definition/paired-mounts.mjs "$relationship"
done
