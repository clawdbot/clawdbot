#!/usr/bin/env bash
set -euo pipefail
output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
evidence="$output_root/evidence"
session_root="$SESSION_ROOT"
node scripts/mantis/telegram-visible-proof.mjs evaluate \
  --scenario "$output_root/scenario" \
  --scenario-hash "$SCENARIO_HASH" \
  --baseline-exit "$BASELINE_EXIT" \
  --baseline-facts "$session_root/baseline.json" \
  --candidate-exit "$CANDIDATE_EXIT" \
  --candidate-facts "$session_root/candidate.json" \
  --published-root "$session_root/published" \
  --output-dir "$evidence" \
  --baseline-ref main \
  --baseline-sha "$BASELINE_SHA" \
  --candidate-ref "$CANDIDATE_SHA" \
  --candidate-sha "$CANDIDATE_SHA"
node scripts/mantis/publish-pr-evidence.mjs \
  --manifest "$evidence/mantis-evidence.json" --validate-only true
comparison_status="$(jq -er '.comparison.outcome | select(. == "pass" or . == "fail" or . == "blocked")' "$evidence/mantis-evidence.json")"
echo "comparison_status=$comparison_status" >> "$GITHUB_OUTPUT"
echo "output_dir=$evidence" >> "$GITHUB_OUTPUT"
