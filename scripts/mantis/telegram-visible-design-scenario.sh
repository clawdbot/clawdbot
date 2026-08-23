#!/usr/bin/env bash
set -euo pipefail
lease_lost_marker="$LEASE_LOST_MARKER"
codex_bin="$(command -v codex)"
output_file="$CODEX_HOME/final-message.txt"
scripts/mantis/run-with-lease-fence.sh "$lease_lost_marker" -- \
  timeout --signal=TERM --kill-after=30s 20m \
  sudo -u codex -- env \
    CODEX_HOME="$CODEX_HOME" \
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE="$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" \
    BASELINE_SHA="$BASELINE_SHA" CANDIDATE_SHA="$CANDIDATE_SHA" \
    GITHUB_WORKSPACE="$GITHUB_WORKSPACE" \
    MANTIS_BASELINE_ROOT="$MANTIS_BASELINE_ROOT" \
    MANTIS_CANDIDATE_ROOT="$MANTIS_CANDIDATE_ROOT" \
    MANTIS_EXPLORE_BASELINE="$MANTIS_EXPLORE_BASELINE" \
    MANTIS_EXPLORE_CANDIDATE="$MANTIS_EXPLORE_CANDIDATE" \
    MANTIS_FIXTURE_BASELINE="$MANTIS_FIXTURE_BASELINE" \
    MANTIS_FIXTURE_CANDIDATE="$MANTIS_FIXTURE_CANDIDATE" \
    MANTIS_INSTRUCTIONS="$MANTIS_INSTRUCTIONS" \
    MANTIS_PR_CONTEXT="$MANTIS_PR_CONTEXT" \
    MANTIS_SCENARIO_DRAFT_DIR="$MANTIS_SCENARIO_DRAFT_DIR" \
    "$codex_bin" exec \
      --skip-git-repo-check \
      --cd "$GITHUB_WORKSPACE" \
      --output-last-message "$output_file" \
      --model gpt-5.6-sol \
      --config 'model_reasoning_effort="high"' \
      -c 'service_tier="fast"' \
      --sandbox danger-full-access \
      - < .github/codex/prompts/mantis-telegram-visible-proof.md
test -f "$MANTIS_SCENARIO_DRAFT_DIR/run.sh"
test -f "$MANTIS_SCENARIO_DRAFT_DIR/config.json"
test -f "$MANTIS_SCENARIO_DRAFT_DIR/assertions.json"
