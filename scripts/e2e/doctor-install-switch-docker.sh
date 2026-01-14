#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="clawdbot-doctor-install-switch-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running doctor install switch E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail

  # Keep logs focused; the npm global install step can emit noisy deprecation warnings.
  export npm_config_loglevel=error
  export npm_config_fund=false
  export npm_config_audit=false

  # Stub systemd/loginctl so doctor + daemon flows work in Docker.
  export PATH="/tmp/clawdbot-bin:$PATH"
  mkdir -p /tmp/clawdbot-bin

  cat > /tmp/clawdbot-bin/systemctl <<"SYSTEMCTL"
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
      exit 0
    fi
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
  chmod +x /tmp/clawdbot-bin/systemctl

  cat > /tmp/clawdbot-bin/loginctl <<"LOGINCTL"
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
	  chmod +x /tmp/clawdbot-bin/loginctl
	
	  # Install the npm-global variant from the local /app source.
	  pkg_tgz="$(npm pack --silent /app)"
	  npm install -g --prefix /tmp/npm-prefix "/app/$pkg_tgz"
	
	  npm_bin="/tmp/npm-prefix/bin/clawdbot"
	  npm_entry="/tmp/npm-prefix/lib/node_modules/clawdbot/dist/entry.js"
	  git_entry="/app/dist/entry.js"

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

    echo "== Flow: $name =="
    home_dir=$(mktemp -d "/tmp/clawdbot-switch-${name}.XXXXXX")
    export HOME="$home_dir"
    export USER="testuser"

    eval "$install_cmd"

    unit_path="$HOME/.config/systemd/user/clawdbot-gateway.service"
    if [ ! -f "$unit_path" ]; then
      echo "Missing unit file: $unit_path"
      exit 1
    fi
    assert_entrypoint "$unit_path" "$install_expected"

    eval "$doctor_cmd"

    assert_entrypoint "$unit_path" "$doctor_expected"
  }

	  run_flow \
	    "npm-to-git" \
	    "$npm_bin daemon install --force" \
	    "$npm_entry" \
	    "node $git_entry doctor --repair --force" \
	    "$git_entry"

	  run_flow \
	    "git-to-npm" \
	    "node $git_entry daemon install --force" \
	    "$git_entry" \
	    "$npm_bin doctor --repair --force" \
	    "$npm_entry"
'
