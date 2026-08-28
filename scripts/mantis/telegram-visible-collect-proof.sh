#!/usr/bin/env bash
set -euo pipefail
output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"

trusted_root="${RUNNER_TEMP}/mantis-trusted-evidence-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
test ! -e "$trusted_root"
install -d -m 0700 "$trusted_root"
install -m 0400 "$output_root/agent-evidence.json" "$trusted_root/agent-evidence.json"
runner_user="$(id -un)"
runner_group="$(id -gn)"
for lane in baseline candidate; do
  sudo install -m 0400 -o "$runner_user" -g "$runner_group" \
    "$SESSION_ROOT/${lane}.json" "$trusted_root/${lane}.json"
done
evidence="$trusted_root/evidence"
node scripts/mantis/telegram-visible-proof.mjs collect \
  --agent-manifest "$trusted_root/agent-evidence.json" \
  --baseline-facts "$trusted_root/baseline.json" \
  --baseline-sha "$BASELINE_SHA" \
  --candidate-facts "$trusted_root/candidate.json" \
  --candidate-sha "$CANDIDATE_SHA" \
  --published-root "$SESSION_ROOT/published" \
  --output-dir "$evidence"
node scripts/mantis/publish-pr-evidence.mjs \
  --manifest "$evidence/mantis-evidence.json" --validate-only true
comparison_status="$(jq -er '.comparison.outcome | select(. == "pass" or . == "fail" or . == "blocked")' "$evidence/mantis-evidence.json")"
echo "comparison_status=$comparison_status" >> "$GITHUB_OUTPUT"
echo "output_dir=$evidence" >> "$GITHUB_OUTPUT"
