#!/bin/bash

set -e

BASE="$HOME/ai/projects/openclaw"
DEST="$BASE/ranchbrain/documents/openclaw"

mkdir -p "$DEST"

echo "Importing Daily Executive Briefings..."
cp -u "$BASE"/reports/daily-briefings/*.txt "$DEST"/ 2>/dev/null || true

echo "Importing Hourly Reports..."
cp -u "$BASE"/reports/system_manager/home_report_*.txt "$DEST"/ 2>/dev/null || true

echo "Importing AI Summaries..."
cp -u "$BASE"/reports/system_manager/home_ai_summary_*.txt "$DEST"/ 2>/dev/null || true

echo
echo "Imported files:"
find "$DEST" -type f | wc -l
