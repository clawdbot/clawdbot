#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
RB="$BASE/ranchbrain"
OUT="$RB/modules/system/import-log.md"

mkdir -p "$RB/modules/system"

{
  echo "# System Report Import Log"
  echo
  echo "Updated: $(date '+%Y-%m-%d %H:%M:%S')"
  echo

  echo "## Daily Briefings"
  find "$BASE/reports/daily-briefings" -type f -name '*.txt' 2>/dev/null | sort | while read -r f; do
    echo "- $(basename "$f")"
  done

  echo
  echo "## System Manager Reports"
  find "$BASE/reports/system_manager" -type f -name '*.txt' 2>/dev/null | sort | while read -r f; do
    echo "- $(basename "$f")"
  done

  echo
  echo "## Watchdog Reports"
  find "$BASE/reports/watchdog" -type f 2>/dev/null | sort | while read -r f; do
    echo "- $(basename "$f")"
  done
} > "$OUT"

echo "Created: $OUT"
cat "$OUT"
