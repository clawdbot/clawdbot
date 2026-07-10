#!/bin/bash
QUERY="$*"
BASE="/mnt/ai-storage/ranchbrain"

if [ -z "$QUERY" ]; then
  echo "Usage: ranchbrain/scripts/search-ranchbrain.sh search terms"
  exit 1
fi

grep -RIn --color=always "$QUERY" "$BASE"/notes "$BASE"/documents 2>/dev/null | head -40
