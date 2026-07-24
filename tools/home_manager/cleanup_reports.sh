#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="$HOME/ai/projects/openclaw/reports"

find "$REPORT_DIR" -type f -mtime +14 -delete

echo "Old reports older than 14 days removed."

echo
echo "Remaining report count:"
find "$REPORT_DIR" -type f | wc -l

echo
echo "Disk usage:"
du -sh "$REPORT_DIR"
