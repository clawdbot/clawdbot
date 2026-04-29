#!/usr/bin/env bash
#
# Runs baseline-to-current bundled plugin update scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_update_scenario() {
  echo "Running bundled channel runtime deps Docker update E2E..."
  run_bundled_channel_container_with_state_heartbeat \
    bundled-channel-update \
    30 \
    "$DOCKER_UPDATE_RUN_TIMEOUT" \
    bundled-channel-update \
    -e OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION="$UPDATE_BASELINE_VERSION" \
    -e "OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=${OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS:-telegram,discord,slack,feishu,memory-lancedb,acpx}" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-update-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_UPDATE_PACKAGE_SPEC=""
export OPENCLAW_BUNDLED_CHANNEL_MEMORY_DB_PATH="~/.openclaw/memory/lancedb-update-e2e"

TOKEN="bundled-channel-update-token"
PORT="18790"
UPDATE_TARGETS="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS:-telegram,discord,slack,feishu,memory-lancedb,acpx}"

poison_home_npm_project() {
  printf '{"name":"openclaw-home-prefix-poison","private":true}\n' >"$HOME/package.json"
  rm -rf "$HOME/node_modules"
  mkdir -p "$HOME/node_modules"
  chmod 500 "$HOME/node_modules"
}

assert_no_unknown_stage_roots() {
  if find "$(bundled_channel_stage_root)" -maxdepth 1 -type d -name 'openclaw-unknown-*' -print -quit 2>/dev/null | grep -q .; then
    echo "runtime deps created second-generation unknown stage roots" >&2
    find "$(bundled_channel_stage_root)" -maxdepth 1 -type d -name 'openclaw-*' -print | sort >&2 || true
    exit 1
  fi
}

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
update_target="file:$package_tgz"
candidate_version="$(node scripts/e2e/lib/bundled-channel/package-version-from-tgz.mjs "$package_tgz")"

assert_update_ok() {
  local json_file="$1"
  local expected_before="$2"
  node scripts/e2e/lib/bundled-channel/assert-update-result.mjs "$json_file" "$expected_before" "$candidate_version"
}

run_update_and_capture() {
  local label="$1"
  local out_file="$2"
  set +e
  openclaw update --tag "$update_target" --yes --json >"$out_file" 2>"/tmp/openclaw-$label-update.stderr"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "openclaw update failed for $label with exit code $status" >&2
    cat "$out_file" >&2 || true
    cat "/tmp/openclaw-$label-update.stderr" >&2 || true
    exit "$status"
  fi
}

should_run_update_target() {
  local target="$1"
  case ",$UPDATE_TARGETS," in
    *",all,"* | *",$target,"*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "Update targets: $UPDATE_TARGETS"
bundled_channel_install_package /tmp/openclaw-update-baseline-install.log "current candidate as update baseline"
command -v openclaw >/dev/null
poison_home_npm_project
baseline_root="$(bundled_channel_package_root)"
test -d "$baseline_root/dist/extensions/telegram"
test -d "$baseline_root/dist/extensions/feishu"
test -d "$baseline_root/dist/extensions/acpx"

if should_run_update_target telegram; then
  echo "Replicating configured Telegram missing-runtime state..."
  bundled_channel_write_config telegram
  bundled_channel_assert_no_dep_available telegram grammy
  set +e
  openclaw doctor --non-interactive >/tmp/openclaw-baseline-doctor.log 2>&1
  baseline_doctor_status=$?
  set -e
  echo "baseline doctor exited with $baseline_doctor_status"
  bundled_channel_remove_runtime_dep telegram grammy
  bundled_channel_assert_no_dep_available telegram grammy

  echo "Updating from baseline to current candidate; candidate doctor must repair Telegram deps..."
  run_update_and_capture telegram /tmp/openclaw-update-telegram.json
  cat /tmp/openclaw-update-telegram.json
  assert_update_ok /tmp/openclaw-update-telegram.json "$candidate_version"
  bundled_channel_assert_dep_available telegram grammy
  assert_no_unknown_stage_roots

  echo "Mutating installed package: remove Telegram deps, then update-mode doctor repairs them..."
  bundled_channel_remove_runtime_dep telegram grammy
  bundled_channel_assert_no_dep_available telegram grammy
  if ! OPENCLAW_UPDATE_IN_PROGRESS=1 openclaw doctor --non-interactive >/tmp/openclaw-update-mode-doctor.log 2>&1; then
    echo "update-mode doctor failed while repairing Telegram deps" >&2
    cat /tmp/openclaw-update-mode-doctor.log >&2
    exit 1
  fi
  bundled_channel_assert_dep_available telegram grammy
  assert_no_unknown_stage_roots
fi

if should_run_update_target discord; then
  echo "Mutating config to Discord and rerunning same-version update path..."
  bundled_channel_write_config discord
  bundled_channel_remove_runtime_dep discord discord-api-types
  bundled_channel_assert_no_dep_available discord discord-api-types
  run_update_and_capture discord /tmp/openclaw-update-discord.json
  cat /tmp/openclaw-update-discord.json
  assert_update_ok /tmp/openclaw-update-discord.json "$candidate_version"
  bundled_channel_assert_dep_available discord discord-api-types
fi

if should_run_update_target slack; then
  echo "Mutating config to Slack and rerunning same-version update path..."
  bundled_channel_write_config slack
  bundled_channel_remove_runtime_dep slack @slack/web-api
  bundled_channel_assert_no_dep_available slack @slack/web-api
  run_update_and_capture slack /tmp/openclaw-update-slack.json
  cat /tmp/openclaw-update-slack.json
  assert_update_ok /tmp/openclaw-update-slack.json "$candidate_version"
  bundled_channel_assert_dep_available slack @slack/web-api
fi

if should_run_update_target feishu; then
  echo "Mutating config to Feishu and rerunning same-version update path..."
  bundled_channel_write_config feishu
  bundled_channel_remove_runtime_dep feishu @larksuiteoapi/node-sdk
  bundled_channel_assert_no_dep_available feishu @larksuiteoapi/node-sdk
  run_update_and_capture feishu /tmp/openclaw-update-feishu.json
  cat /tmp/openclaw-update-feishu.json
  assert_update_ok /tmp/openclaw-update-feishu.json "$candidate_version"
  bundled_channel_assert_dep_available feishu @larksuiteoapi/node-sdk
fi

if should_run_update_target memory-lancedb; then
  echo "Mutating config to memory-lancedb and rerunning same-version update path..."
  bundled_channel_write_config memory-lancedb
  bundled_channel_remove_runtime_dep memory-lancedb @lancedb/lancedb
  bundled_channel_assert_no_dep_available memory-lancedb @lancedb/lancedb
  run_update_and_capture memory-lancedb /tmp/openclaw-update-memory-lancedb.json
  cat /tmp/openclaw-update-memory-lancedb.json
  assert_update_ok /tmp/openclaw-update-memory-lancedb.json "$candidate_version"
  bundled_channel_assert_dep_available memory-lancedb @lancedb/lancedb
fi

if should_run_update_target acpx; then
  echo "Removing ACPX runtime package and rerunning same-version update path..."
  bundled_channel_write_config acpx
  bundled_channel_remove_runtime_dep acpx acpx
  bundled_channel_assert_no_dep_available acpx acpx
  run_update_and_capture acpx /tmp/openclaw-update-acpx.json
  cat /tmp/openclaw-update-acpx.json
  assert_update_ok /tmp/openclaw-update-acpx.json "$candidate_version"
  bundled_channel_assert_dep_available acpx acpx
fi

echo "bundled channel runtime deps Docker update E2E passed"
EOF
}
