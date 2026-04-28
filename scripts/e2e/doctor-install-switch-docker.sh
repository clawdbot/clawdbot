#!/usr/bin/env bash
# Verifies doctor/daemon repair switches service entrypoints between package and
# git installs. Both fixtures come from the same prepared OpenClaw npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-doctor-install-switch-e2e" OPENCLAW_DOCTOR_INSTALL_SWITCH_E2E_IMAGE)"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz doctor-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" doctor-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare"

echo "Running doctor install switch E2E..."
docker run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc '
  set -euo pipefail

  # Keep logs focused; the npm global install step can emit noisy deprecation warnings.
  export npm_config_loglevel=error
  export npm_config_fund=false
  export npm_config_audit=false
  export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1

  # Stub systemd/loginctl so doctor + daemon flows work in Docker.
  export PATH="/tmp/openclaw-bin:$PATH"
  mkdir -p /tmp/openclaw-bin

  cat > /tmp/openclaw-bin/systemctl <<"SYSTEMCTL"
#!/usr/bin/env bash
set -euo pipefail

args=("$@")
if [[ "${args[0]:-}" == "--user" ]]; then
  args=("${args[@]:1}")
fi
cmd="${args[0]:-}"
case "$cmd" in
  status)
    exit 0
    ;;
  is-active)
    echo "inactive" >&2
    exit 3
    ;;
  is-enabled)
    unit="${args[1]:-}"
    unit_path="$HOME/.config/systemd/user/${unit}"
    if [ -f "$unit_path" ]; then
      echo "enabled"
      exit 0
    fi
    echo "disabled" >&2
    exit 1
    ;;
  show)
    echo "ActiveState=inactive"
    echo "SubState=dead"
    echo "MainPID=0"
    echo "ExecMainStatus=0"
    echo "ExecMainCode=0"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
SYSTEMCTL
  chmod +x /tmp/openclaw-bin/systemctl

  cat > /tmp/openclaw-bin/loginctl <<"LOGINCTL"
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *"show-user"* ]]; then
  echo "Linger=yes"
  exit 0
fi
if [[ "$*" == *"enable-linger"* ]]; then
  exit 0
fi
exit 0
LOGINCTL
  chmod +x /tmp/openclaw-bin/loginctl

  package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
  git_root="/tmp/openclaw-git"
  mkdir -p "$git_root"
  # The git-style install fixture is unpacked from the tarball so this lane does
  # not depend on checkout source files being present in the Docker image.
  tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
  (
    cd "$git_root"
    npm install --omit=optional --no-fund --no-audit >/tmp/openclaw-git-install.log 2>&1
    git init -q
    git config user.email "docker-e2e@openclaw.local"
    git config user.name "OpenClaw Docker E2E"
    git add -A
    git commit -qm "test fixture"
  )
  npm_log="/tmp/openclaw-doctor-switch-npm-install.log"
  if ! npm install -g --prefix /tmp/npm-prefix "$package_tgz" >"$npm_log" 2>&1; then
    cat "$npm_log"
    exit 1
  fi

	  npm_bin="/tmp/npm-prefix/bin/openclaw"
	  npm_root="/tmp/npm-prefix/lib/node_modules/openclaw"
	  if [ -f "$npm_root/dist/index.mjs" ]; then
	    npm_entry="$npm_root/dist/index.mjs"
	  else
	    npm_entry="$npm_root/dist/index.js"
	  fi

	  if [ -f "$git_root/dist/index.mjs" ]; then
	    git_entry="$git_root/dist/index.mjs"
	  else
	    git_entry="$git_root/dist/index.js"
	  fi
	  git_cli="$git_root/openclaw.mjs"

  package_version="$(node -p "require(\"$npm_root/package.json\").version")"
  is_legacy_package_acceptance_compat() {
    node - "$1" <<"NODE"
const version = process.argv[2] || "";
const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/.exec(version);
if (!match) process.exit(1);
const value = [Number(match[1]), Number(match[2]), Number(match[3])];
const max = [2026, 4, 25];
for (let i = 0; i < value.length; i += 1) {
  if (value[i] < max[i]) process.exit(0);
  if (value[i] > max[i]) process.exit(1);
}
process.exit(0);
NODE
  }

  assert_entrypoint() {
    local unit_path="$1"
    local expected="$2"
    local exec_line=""
    exec_line=$(grep -m1 "^ExecStart=" "$unit_path" || true)
    if [ -z "$exec_line" ]; then
      echo "Missing ExecStart in $unit_path"
      exit 1
	    fi
	    exec_line="${exec_line#ExecStart=}"
	    entrypoint=$(echo "$exec_line" | awk "{print \$2}")
	    entrypoint="${entrypoint%\"}"
	    entrypoint="${entrypoint#\"}"
	    if [ "$entrypoint" != "$expected" ]; then
	      echo "Expected entrypoint $expected, got $entrypoint"
	      exit 1
	    fi
	  }

  assert_exec_arg() {
    local unit_path="$1"
    local index="$2"
    local expected="$3"
    local exec_line=""
    local actual=""
    exec_line=$(grep -m1 "^ExecStart=" "$unit_path" || true)
    if [ -z "$exec_line" ]; then
      echo "Missing ExecStart in $unit_path"
      exit 1
    fi
    exec_line="${exec_line#ExecStart=}"
    actual=$(echo "$exec_line" | awk -v field="$index" "{print \$field}")
    actual="${actual%\"}"
    actual="${actual#\"}"
    if [ "$actual" != "$expected" ]; then
      echo "Expected ExecStart arg $index to be $expected, got $actual"
      cat "$unit_path"
      exit 1
    fi
  }

  assert_env_value() {
    local unit_path="$1"
    local key="$2"
    local expected="$3"
    if ! grep -Fxq "Environment=${key}=${expected}" "$unit_path"; then
      echo "Expected Environment=${key}=${expected} in $unit_path"
      cat "$unit_path"
      exit 1
    fi
  }

  assert_no_env_key() {
    local unit_path="$1"
    local key="$2"
    if grep -q "^Environment=${key}=" "$unit_path"; then
      echo "Expected no Environment=${key}= line in $unit_path"
      cat "$unit_path"
      exit 1
    fi
  }

  # Each flow: install service with one variant, run doctor from the other,
  # and verify ExecStart entrypoint switches accordingly.
  run_flow() {
    local name="$1"
    local install_cmd="$2"
    local install_expected="$3"
    local doctor_cmd="$4"
    local doctor_expected="$5"
    local install_log="/tmp/openclaw-doctor-switch-${name}-install.log"
    local doctor_log="/tmp/openclaw-doctor-switch-${name}-doctor.log"
    local command_timeout="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-300s}"

    echo "== Flow: $name =="
    home_dir=$(mktemp -d "/tmp/openclaw-switch-${name}.XXXXXX")
    export HOME="$home_dir"
    export USER="testuser"

    if ! timeout "$command_timeout" bash -c "$install_cmd" >"$install_log" 2>&1; then
      cat "$install_log"
      exit 1
    fi
    rm -f "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"
    rm -rf "$HOME/.config/fish" "$HOME/.config/powershell"

    unit_path="$HOME/.config/systemd/user/openclaw-gateway.service"
    if [ ! -f "$unit_path" ]; then
      echo "Missing unit file: $unit_path"
      exit 1
    fi
    assert_entrypoint "$unit_path" "$install_expected"

    if ! timeout "$command_timeout" bash -c "$doctor_cmd" >"$doctor_log" 2>&1; then
      cat "$doctor_log"
      exit 1
    fi

    assert_entrypoint "$unit_path" "$doctor_expected"
  }

  run_flow \
    "npm-to-git" \
    "$npm_bin daemon install --force" \
    "$npm_entry" \
    "node $git_cli doctor --repair --force --yes" \
    "$git_entry"

  run_flow \
    "git-to-npm" \
    "node $git_cli daemon install --force" \
    "$git_entry" \
    "$npm_bin doctor --repair --force --yes" \
    "$npm_entry"

  run_proxy_env_flow() {
    local name="proxy-env-cleanup"
    local install_log="/tmp/openclaw-doctor-switch-${name}-install.log"
    local doctor_log="/tmp/openclaw-doctor-switch-${name}-doctor.log"
    local command_timeout="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-300s}"

    echo "== Flow: $name =="
    home_dir=$(mktemp -d "/tmp/openclaw-switch-${name}.XXXXXX")
    export HOME="$home_dir"
    export USER="testuser"

    unit_path="$HOME/.config/systemd/user/openclaw-gateway.service"
    if ! timeout "$command_timeout" env \
      HTTP_PROXY="http://proxy.local:7890" \
      HTTPS_PROXY="https://proxy.local:7890" \
      NO_PROXY="localhost,127.0.0.1" \
      "$npm_bin" gateway install --force >"$install_log" 2>&1; then
      cat "$install_log"
      exit 1
    fi
    assert_no_env_key "$unit_path" "HTTP_PROXY"
    assert_no_env_key "$unit_path" "HTTPS_PROXY"
    assert_no_env_key "$unit_path" "NO_PROXY"

    {
      printf "%s\n" "Environment=HTTP_PROXY=http://stale-proxy.local:7890"
      printf "%s\n" "Environment=HTTPS_PROXY=https://stale-proxy.local:7890"
    } >>"$unit_path"
    if ! timeout "$command_timeout" node "$git_cli" doctor --repair --yes >"$doctor_log" 2>&1; then
      cat "$doctor_log"
      exit 1
    fi
    assert_no_env_key "$unit_path" "HTTP_PROXY"
    assert_no_env_key "$unit_path" "HTTPS_PROXY"
  }

  run_proxy_env_flow

  run_wrapper_flow() {
    local name="wrapper-persistence"
    local install_log="/tmp/openclaw-doctor-switch-${name}-install.log"
    local reinstall_log="/tmp/openclaw-doctor-switch-${name}-reinstall.log"
    local env_repair_log="/tmp/openclaw-doctor-switch-${name}-env-repair.log"
    local doctor_log="/tmp/openclaw-doctor-switch-${name}-doctor.log"
    local clear_log="/tmp/openclaw-doctor-switch-${name}-clear.log"
    local command_timeout="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-300s}"

    echo "== Flow: $name =="
    home_dir=$(mktemp -d "/tmp/openclaw-switch-${name}.XXXXXX")
    export HOME="$home_dir"
    export USER="testuser"
    mkdir -p "$HOME/.local/bin"
    local wrapper="$HOME/.local/bin/openclaw-wrapper"
    cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
printf "%s\n" "\$@" >> "$HOME/openclaw-wrapper-argv.log"
exec "$npm_bin" "\$@"
WRAPPER
    chmod +x "$wrapper"

    local unit_path="$HOME/.config/systemd/user/openclaw-gateway.service"

    if ! timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" --force >"$install_log" 2>&1; then
      cat "$install_log"
      exit 1
    fi
    assert_exec_arg "$unit_path" 1 "$wrapper"
    assert_exec_arg "$unit_path" 2 "gateway"
    assert_env_value "$unit_path" "OPENCLAW_WRAPPER" "$wrapper"

    if ! timeout "$command_timeout" "$npm_bin" gateway install --force >"$reinstall_log" 2>&1; then
      cat "$reinstall_log"
      exit 1
    fi
    assert_exec_arg "$unit_path" 1 "$wrapper"
    assert_exec_arg "$unit_path" 2 "gateway"
    assert_env_value "$unit_path" "OPENCLAW_WRAPPER" "$wrapper"

    sed -i "/^Environment=OPENCLAW_WRAPPER=/d" "$unit_path"
    if ! timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" >"$env_repair_log" 2>&1; then
      cat "$env_repair_log"
      exit 1
    fi
    assert_exec_arg "$unit_path" 1 "$wrapper"
    assert_env_value "$unit_path" "OPENCLAW_WRAPPER" "$wrapper"

    sed -i "s#^Environment=OPENCLAW_WRAPPER=.*#Environment=OPENCLAW_WRAPPER=/tmp/stale-openclaw-wrapper#" "$unit_path"
    if ! timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" >"$env_repair_log" 2>&1; then
      cat "$env_repair_log"
      exit 1
    fi
    assert_exec_arg "$unit_path" 1 "$wrapper"
    assert_env_value "$unit_path" "OPENCLAW_WRAPPER" "$wrapper"

    if ! timeout "$command_timeout" node "$git_cli" doctor --repair --force --yes >"$doctor_log" 2>&1; then
      cat "$doctor_log"
      exit 1
    fi
    if ! grep -Fq "Gateway service invokes OPENCLAW_WRAPPER:" "$doctor_log"; then
      echo "Expected doctor to report active wrapper"
      cat "$doctor_log"
      exit 1
    fi
    assert_exec_arg "$unit_path" 1 "$wrapper"
    assert_env_value "$unit_path" "OPENCLAW_WRAPPER" "$wrapper"

    if ! timeout "$command_timeout" env OPENCLAW_WRAPPER= "$npm_bin" gateway install --force >"$clear_log" 2>&1; then
      cat "$clear_log"
      exit 1
    fi
    assert_no_env_key "$unit_path" "OPENCLAW_WRAPPER"
    assert_entrypoint "$unit_path" "$npm_entry"
  }

  if "$npm_bin" gateway install --help 2>&1 | grep -q -- "--wrapper"; then
    run_wrapper_flow
  elif is_legacy_package_acceptance_compat "$package_version"; then
    # Legacy compatibility: 2026.4.25 and older did not ship gateway install --wrapper.
    echo "Skipping wrapper persistence; package gateway install does not support --wrapper."
  else
    echo "Package $package_version must support gateway install --wrapper." >&2
    exit 1
  fi
'
