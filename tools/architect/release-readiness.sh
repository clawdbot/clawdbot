#!/bin/bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
REPORT="$BASE/reports/architect/release-readiness-latest.txt"

mkdir -p "$(dirname "$REPORT")"

{
  echo "========================================"
  echo "Architect Release Readiness"
  echo "========================================"
  date
  echo

  echo "Git Status"
  echo "----------"
  git status --short || true
  echo

  echo "RanchBrain Status"
  echo "-----------------"
  ranchbrain/ranchbrain status || true
  echo

  echo "Foundation ADRs"
  echo "---------------"
  find /mnt/ai-storage/ranchbrain/Foundation/ADR -type f 2>/dev/null | sort || true
  echo

  echo "Asset JSON Validation"
  echo "---------------------"
  FAIL=0
  while IFS= read -r f; do
    if python3 -m json.tool "$f" >/dev/null 2>&1; then
      echo "OK: $f"
    else
      echo "FAIL: $f"
      FAIL=1
    fi
  done < <(find /mnt/ai-storage/ranchbrain/assets -name '*.json' 2>/dev/null | sort)

  echo
  echo "Readiness Summary"
  echo "-----------------"
  if [ "$FAIL" -eq 0 ]; then
    echo "READY_FOR_REVIEW=yes"
  else
    echo "READY_FOR_REVIEW=no"
  fi

  echo
  echo "Architect prepares. The Steward approves."
  echo "No commit, tag, push, or destructive action was performed."
} | tee "$REPORT"

echo
echo "Report saved to: $REPORT"
