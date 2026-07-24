#!/usr/bin/env bash
set -euo pipefail

TREND_FILE="$HOME/ai/projects/openclaw/reports/trends.csv"

if [ ! -f "$TREND_FILE" ]; then
  echo "No trends.csv found yet."
  exit 0
fi

echo "Trend file:"
echo "$TREND_FILE"
echo

echo "Latest 10 samples:"
tail -10 "$TREND_FILE"
echo

echo "Quick stats:"
awk -F',' '
NR > 1 {
  count++
  latency += $2
  mem += $3
  disk += $5
}
END {
  if (count > 0) {
    printf "Samples: %d\n", count
    printf "Average Ollama latency ms: %.0f\n", latency / count
    printf "Average memory used GiB: %.1f\n", mem / count
    printf "Average disk used %%: %.1f\n", disk / count
  }
}
' "$TREND_FILE"
