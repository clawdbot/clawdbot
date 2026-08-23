#!/usr/bin/env bash
# Small agent-facing API for one frozen real-user Telegram proof scenario.
# Trusted workflow code binds the private baseline/candidate lane outside this script.

set -euo pipefail

: "${MANTIS_SCENARIO_DIR:?MANTIS_SCENARIO_DIR is required}"
: "${MANTIS_SCENARIO_OUTPUT_DIR:?MANTIS_SCENARIO_OUTPUT_DIR is required}"
: "${MANTIS_SCENARIO_HELPER:?MANTIS_SCENARIO_HELPER is required}"
: "${MANTIS_TELEGRAM_BRIDGE:?MANTIS_TELEGRAM_BRIDGE is required}"
: "${MANTIS_FIXTURE_DIR:?MANTIS_FIXTURE_DIR is required}"

mkdir -p "$MANTIS_SCENARIO_OUTPUT_DIR" "$MANTIS_FIXTURE_DIR"

proof_name() {
  local value="$1"
  [[ "$value" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || {
    echo "proof result names must match [a-z][a-z0-9-]{0,63}: $value" >&2
    return 64
  }
  printf '%s\n' "$value"
}

proof_asset() {
  local relative="$1"
  [[ -n "$relative" && "$relative" != /* && "$relative" != *".."* ]] || {
    echo "proof assets must stay inside the frozen scenario: $relative" >&2
    return 64
  }
  local resolved="$MANTIS_SCENARIO_DIR/$relative"
  [[ -f "$resolved" ]] || {
    echo "missing proof asset: $relative" >&2
    return 66
  }
  printf '%s\n' "$resolved"
}

proof_call() {
  local name
  name="$(proof_name "$1")"
  shift
  local output="$MANTIS_SCENARIO_OUTPUT_DIR/$name.json"
  "$MANTIS_TELEGRAM_BRIDGE" "$@" | tee "$output"
}

proof_result() {
  local name
  name="$(proof_name "$1")"
  local query="$2"
  jq -er "$query" "$MANTIS_SCENARIO_OUTPUT_DIR/$name.json"
}

proof_stage_fixture() {
  local source_relative="$1"
  local target_relative="${2:-$(basename "$source_relative")}"
  [[ -n "$target_relative" && "$target_relative" != /* && "$target_relative" != *".."* ]] || {
    echo "fixture destinations must stay inside the lane fixture directory" >&2
    return 64
  }
  local source="$MANTIS_SCENARIO_DIR/$source_relative"
  [[ -e "$source" && ! -L "$source" ]] || {
    echo "missing or invalid fixture asset: $source_relative" >&2
    return 66
  }
  local target="$MANTIS_FIXTURE_DIR/$target_relative"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  cp -R --no-preserve=ownership "$source" "$target"
}

proof_start() {
  local name="$1"
  local config="${2:-config.json}"
  proof_call "$name" start --config "$(proof_asset "$config")"
}

proof_mock_text() {
  local name="$1"
  local response_file="$2"
  shift 2
  proof_call "$name" mock --response-file "$(proof_asset "$response_file")" "$@"
}

proof_mock_events() {
  local name="$1"
  local events_file="$2"
  proof_call "$name" mock --response-events-file "$(proof_asset "$events_file")"
}

proof_mock_script() {
  local name="$1"
  local script_file="$2"
  local script_path
  script_path="$(proof_asset "$script_file")"
  local digest
  digest="$(sha256sum "$script_path" | cut -d ' ' -f1)"
  proof_call "$name" mock --script "$script_path" "$digest"
}

proof_send() {
  local name="$1"
  shift
  proof_call "$name" send "$@"
}

proof_turn() {
  local name="$1"
  shift
  proof_call "$name" turn "$@"
}

proof_observe() {
  local name="$1"
  shift
  proof_call "$name" observe "$@"
}

proof_press() {
  local name="$1"
  shift
  proof_call "$name" press "$@"
}

proof_delete() {
  local name="$1"
  shift
  proof_call "$name" delete "$@"
}

proof_desktop() {
  local name="$1"
  local actions_file="$2"
  shift 2
  proof_call "$name" desktop --actions-file "$(proof_asset "$actions_file")" "$@"
}

proof_screenshot() {
  local name="$1"
  proof_call "$name" screenshot
}

proof_view() {
  local name="$1"
  shift
  proof_call "$name" view "$@"
}

proof_exec() {
  local name="$1"
  shift
  proof_call "$name" exec "$@"
}

proof_exec_file() {
  local name="$1"
  local command_file="$2"
  shift 2
  proof_call "$name" exec --command-file "$(proof_asset "$command_file")" "$@"
}

proof_restart() {
  local name="$1"
  shift
  proof_call "$name" restart "$@"
}

proof_finish() {
  local name="$1"
  shift
  proof_call "$name" finish "$@"
}

proof_abort() {
  "$MANTIS_TELEGRAM_BRIDGE" abort >/dev/null 2>&1 || true
}
