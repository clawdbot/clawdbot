#!/usr/bin/env bash
set -euo pipefail
codex_bin="$(command -v codex)"
output_file="$CODEX_HOME/final-message.txt"
agent_output_dir="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
scripts/mantis/run-with-lease-fence.sh "$LEASE_LOST_MARKER" -- \
  timeout --signal=TERM --kill-after=30s 60m \
  sudo -u codex -- env \
    CODEX_HOME="$CODEX_HOME" \
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE="$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" \
    BASELINE_SHA="$BASELINE_SHA" CANDIDATE_SHA="$CANDIDATE_SHA" \
    GITHUB_WORKSPACE="$GITHUB_WORKSPACE" \
    MANTIS_BASELINE_ROOT="$MANTIS_BASELINE_ROOT" \
    MANTIS_CANDIDATE_ROOT="$MANTIS_CANDIDATE_ROOT" \
    MANTIS_BASELINE="$MANTIS_BASELINE" \
    MANTIS_CANDIDATE="$MANTIS_CANDIDATE" \
    MANTIS_FIXTURE_BASELINE="$MANTIS_FIXTURE_BASELINE" \
    MANTIS_FIXTURE_CANDIDATE="$MANTIS_FIXTURE_CANDIDATE" \
    MANTIS_INSTRUCTIONS="$MANTIS_INSTRUCTIONS" \
    MANTIS_PR_CONTEXT="$MANTIS_PR_CONTEXT" \
    MANTIS_OUTPUT_DIR="$agent_output_dir" \
    "$codex_bin" exec \
      --skip-git-repo-check \
      --cd "$GITHUB_WORKSPACE" \
      --output-last-message "$output_file" \
      --model gpt-5.6-sol \
      --config 'model_reasoning_effort="high"' \
      -c 'service_tier="fast"' \
      --sandbox danger-full-access \
      - < .github/codex/prompts/mantis-telegram-visible-proof.md
test -f "$agent_output_dir/agent-evidence.json"
