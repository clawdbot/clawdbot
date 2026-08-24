#!/usr/bin/env bash
set -euo pipefail
output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
evidence="$output_root/evidence"
node scripts/mantis/telegram-visible-proof.mjs collect \
  --agent-manifest "$output_root/agent-evidence.json" \
  --baseline-facts "$SESSION_ROOT/baseline.json" \
  --baseline-sha "$BASELINE_SHA" \
  --candidate-facts "$SESSION_ROOT/candidate.json" \
  --candidate-sha "$CANDIDATE_SHA" \
  --published-root "$SESSION_ROOT/published" \
  --output-dir "$evidence"
node scripts/mantis/publish-pr-evidence.mjs \
  --manifest "$evidence/mantis-evidence.json" --validate-only true
comparison_status="$(jq -er '.comparison.outcome | select(. == "pass" or . == "fail" or . == "blocked")' "$evidence/mantis-evidence.json")"
echo "comparison_status=$comparison_status" >> "$GITHUB_OUTPUT"
echo "output_dir=$evidence" >> "$GITHUB_OUTPUT"
