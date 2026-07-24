#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="$HOME/ai/projects/openclaw/reports"
BASELINE_DIR="$REPORT_DIR/baseline"
mkdir -p "$BASELINE_DIR"

LATEST_REPORT="$(find "$REPORT_DIR" -maxdepth 1 -type f -name 'home_report_*.txt' -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {sub(/^[^ ]+ /,""); print}')"
LATEST_SUMMARY="$(find "$REPORT_DIR" -maxdepth 1 -type f -name 'home_ai_summary_*.txt' -printf '%T@ %p\n' | sort -nr | awk 'NR==1 {sub(/^[^ ]+ /,""); print}')"

if [[ -z "${LATEST_REPORT:-}" || -z "${LATEST_SUMMARY:-}" ]]; then
  echo "No report/summary found for baseline."
  exit 0
fi

cp -f "$LATEST_REPORT" "$BASELINE_DIR/home_report_gold.txt"
cp -f "$LATEST_SUMMARY" "$BASELINE_DIR/home_ai_summary_gold.txt"

echo "Daily gold baseline updated:"
echo "Report:  $BASELINE_DIR/home_report_gold.txt"
echo "Summary: $BASELINE_DIR/home_ai_summary_gold.txt"
