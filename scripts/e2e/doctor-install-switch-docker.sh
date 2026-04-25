#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-doctor-install-switch-e2e" OPENCLAW_DOCTOR_INSTALL_SWITCH_E2E_IMAGE)"

docker_e2e_build_or_reuse "$IMAGE_NAME" doctor-switch

echo "Running doctor install switch E2E..."
docker run --rm -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$IMAGE_NAME" bash -lc '
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

  # Install the npm-global variant from the local /app source.
  # `npm pack` can emit script output; keep only the tarball name.
  pkg_tgz="$(npm pack --ignore-scripts --silent /app | tail -n 1 | tr -d '\r')"
  if [ ! -f "/app/$pkg_tgz" ]; then
    echo "npm pack failed (expected /app/$pkg_tgz)"
    exit 1
  fi
  npm_log="/tmp/openclaw-doctor-switch-npm-install.log"
  if ! npm install -g --prefix /tmp/npm-prefix "/app/$pkg_tgz" >"$npm_log" 2>&1; then
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

	  if [ -f "/app/dist/index.mjs" ]; then
	    git_entry="/app/dist/index.mjs"
	  else
	    git_entry="/app/dist/index.js"
	  fi
	  git_cli="/app/openclaw.mjs"

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
'
