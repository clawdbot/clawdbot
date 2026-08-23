#!/usr/bin/env bash
set -euo pipefail
stop_codex_processes() {
  sudo pkill -TERM -u codex 2>/dev/null || true
  for _ in {1..10}; do
    [[ -z "$(sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}')" ]] && return
    sleep 1
  done
  sudo pkill -KILL -u codex 2>/dev/null || true
  [[ -z "$(sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}')" ]]
}
stop_codex_processes

output_root="$GITHUB_WORKSPACE/$MANTIS_OUTPUT_DIR"
draft="$output_root/scenario-draft"
frozen="$output_root/scenario"
metadata="$output_root/scenario-freeze.json"
for lane in baseline candidate; do
  "/usr/local/bin/mantis-telegram-${lane}" abort >/dev/null 2>&1 || true
done
node scripts/mantis/telegram-visible-proof.mjs freeze \
  --draft "$draft" --frozen "$frozen" --metadata "$metadata"
scenario_hash="$(jq -er .hash "$metadata")"
sudo chown -R root:root "$frozen" "$metadata"
sudo chmod -R a-w "$frozen" "$metadata"
sudo rm -rf "$draft"

session_root="$SESSION_ROOT"
sudo rm -rf "$session_root/attempts" "$session_root/published" \
  "$session_root/baseline.json" "$session_root/candidate.json"
sudo rm -rf "$output_root/baseline" "$output_root/candidate" "$output_root/scenario-results"
sudo install -d -m 2770 -o codex -g mantis-proof "$output_root/scenario-results"
for lane in baseline candidate; do
  sudo install -d -m 2770 -o codex -g mantis-proof "$output_root/scenario-results/$lane"
  sudo find "$session_root/fixture-plugins/$lane" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
done
echo "scenario_hash=$scenario_hash" >> "$GITHUB_OUTPUT"
