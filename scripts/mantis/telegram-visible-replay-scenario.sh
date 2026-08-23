#!/usr/bin/env bash
set -euo pipefail
output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
scenario="$output_root/scenario"
helper="$GITHUB_WORKSPACE/scripts/mantis/telegram-proof-scenario.sh"
session_root="$SESSION_ROOT"
stop_codex_processes() {
  sudo pkill -TERM -u codex 2>/dev/null || true
  for _ in {1..5}; do
    [[ -z "$(sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}')" ]] && return
    sleep 1
  done
  sudo pkill -KILL -u codex 2>/dev/null || true
  [[ -z "$(sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}')" ]]
}

run_lane() {
  local lane="$1"
  local bridge="/usr/local/bin/mantis-telegram-${lane}"
  local result_dir="$output_root/scenario-results/$lane"
  local fixture_dir="$session_root/fixture-plugins/$lane"
  set +e
  sudo -u codex env -i \
    HOME=/home/codex \
    PATH=/usr/local/lib/mantis-toolchain:/usr/local/bin:/usr/bin:/bin \
    MANTIS_FIXTURE_DIR="$fixture_dir" \
    MANTIS_SCENARIO_DIR="$scenario" \
    MANTIS_SCENARIO_HELPER="$helper" \
    MANTIS_SCENARIO_OUTPUT_DIR="$result_dir" \
    MANTIS_TELEGRAM_BRIDGE="$bridge" \
    timeout --signal=TERM --kill-after=30s 20m bash "$scenario/run.sh" \
    >"$result_dir/run.log" 2>&1
  local status=$?
  set -e
  stop_codex_processes
  printf '%s\n' "$status" >"$result_dir/exit-code.txt"
  if sudo test -f "$session_root/${lane}.active.json" || sudo test -f "$session_root/${lane}.starting.json"; then
    "$bridge" abort >/dev/null 2>&1 || true
  fi
}
run_lane baseline
run_lane candidate
echo "baseline_exit=$(cat "$output_root/scenario-results/baseline/exit-code.txt")" >> "$GITHUB_OUTPUT"
echo "candidate_exit=$(cat "$output_root/scenario-results/candidate/exit-code.txt")" >> "$GITHUB_OUTPUT"
