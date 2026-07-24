#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
REPORT_DIR="$BASE/reports"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$REPORT_DIR"

REPORT_FILE="$REPORT_DIR/home_report_$STAMP.txt"
SUMMARY_FILE="$REPORT_DIR/home_ai_summary_$STAMP.txt"

REPORT_TMP="$(mktemp "$REPORT_DIR/.home_report_${STAMP}.XXXXXX")"
SUMMARY_TMP="$(mktemp "$REPORT_DIR/.home_ai_summary_${STAMP}.XXXXXX")"

cleanup() {
  rm -f "$REPORT_TMP" "$SUMMARY_TMP"
}
trap cleanup EXIT

if ! "$BASE/tools/home_manager/home_status_report.sh" > "$REPORT_TMP"; then
  echo "WARNING: Home status report completed with one or more errors." >&2
fi

if ! "$BASE/tools/home_manager/homemanager_summary.sh" > "$SUMMARY_TMP"; then
  echo "AI summary unavailable: summary generator failed unexpectedly" > "$SUMMARY_TMP"
fi

if [[ ! -s "$REPORT_TMP" ]]; then
  echo "Home status report unavailable" > "$REPORT_TMP"
fi

if [[ ! -s "$SUMMARY_TMP" ]]; then
  echo "AI summary unavailable: empty summary output" > "$SUMMARY_TMP"
fi

mv "$REPORT_TMP" "$REPORT_FILE"
mv "$SUMMARY_TMP" "$SUMMARY_FILE"

echo "Hourly snapshot complete"
echo "Report:  $REPORT_FILE"
echo "Summary: $SUMMARY_FILE"

ls -lh "$REPORT_FILE" "$SUMMARY_FILE"

echo
echo "Running report cleanup..."
"$BASE/tools/home_manager/cleanup_reports.sh"

echo
echo "Updating daily gold baseline..."
"$BASE/tools/home_manager/daily_baseline.sh"

echo
echo "Collecting trend sample..."
"$BASE/tools/home_manager/collect_trends.sh"

echo
echo "Running anomaly detection..."
"$BASE/tools/home_manager/detect_anomalies.sh" \
  > "$REPORT_DIR/anomaly_latest.txt"

cat "$REPORT_DIR/anomaly_latest.txt"
