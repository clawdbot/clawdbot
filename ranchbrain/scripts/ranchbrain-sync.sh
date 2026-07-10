#!/bin/bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
LOG_DIR="$BASE/ranchbrain/reports"
LOG="$LOG_DIR/ranchbrain-sync-latest.log"

mkdir -p "$LOG_DIR"

{
  echo "===== RanchBrain Sync ====="
  date

  echo
  echo "Importing reports..."
  "$BASE/ranchbrain/scripts/import-openclaw-reports.sh"

  echo
  echo "Creating metadata..."
  python3 "$BASE/ranchbrain/src/ranchbrain/metadata_scan.py"

  echo
  echo "Indexing chunks..."
  python3 "$BASE/ranchbrain/src/ranchbrain/indexer.py"

  echo
  echo "Embedding missing chunks..."
  while true; do
    OUT="$(python3 "$BASE/ranchbrain/src/ranchbrain/embedder.py")"
    echo "$OUT"
    echo "$OUT" | grep -q "Remaining: 0" && break
    echo "$OUT" | grep -q "No chunks need embeddings" && break
  done

  echo
  echo "RanchBrain status:"
  "$BASE/ranchbrain/ranchbrain" status

  echo
  echo "Sync complete."
  date
} | tee "$LOG"
