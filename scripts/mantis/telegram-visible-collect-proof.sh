#!/usr/bin/env bash
set -euo pipefail
output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"

active_codex_pids() {
  sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}' || true
}
sudo pkill -TERM -u codex 2>/dev/null || true
for _ in {1..10}; do
  [[ -z "$(active_codex_pids)" ]] && break
  sleep 1
done
sudo pkill -KILL -u codex 2>/dev/null || true
[[ -z "$(active_codex_pids)" ]] || {
  echo "Codex processes remained before evidence collection." >&2
  exit 1
}

trusted_root="${RUNNER_TEMP}/mantis-trusted-evidence-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
test ! -e "$trusted_root"
install -d -m 0700 "$trusted_root"
install -m 0400 "$output_root/agent-evidence.json" "$trusted_root/agent-evidence.json"
evidence="$trusted_root/evidence"
node scripts/mantis/telegram-visible-proof.mjs collect \
  --agent-manifest "$trusted_root/agent-evidence.json" \
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
