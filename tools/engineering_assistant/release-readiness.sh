#!/bin/bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
REPORT="$BASE/reports/engineering_assistant/release-readiness-latest.txt"

mkdir -p "$(dirname "$REPORT")"

{
  echo "========================================"
  echo "OpenClaw / RanchBrain Release Readiness"
  echo "========================================"
  date
  echo

  echo "Git Status"
  echo "----------"
  git status --short || true
  echo

  echo "Current Branch"
  echo "--------------"
  git branch --show-current || true
  echo

  echo "Recent Commits"
  echo "--------------"
  git log --oneline -5 || true
  echo

  echo "RanchBrain Status"
  echo "-----------------"
  ranchbrain/ranchbrain status || true
  echo

  echo "Foundation Documents"
  echo "--------------------"
  find /mnt/ai-storage/ranchbrain/Foundation -type f 2>/dev/null | sort || true
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

  echo "Systemd User Timers"
  echo "-------------------"
  systemctl --user list-timers --all | grep -Ei 'openclaw|ranchbrain|propertymanager' || true
  echo

  echo "Docker Containers"
  echo "-----------------"
  docker ps --format "table {{.Names}}\t{{.Status}}" || true
  echo

  echo "Readiness Summary"
  echo "-----------------"
  if [ "$FAIL" -eq 0 ]; then
    echo "READY_FOR_REVIEW=yes"
    echo "No JSON validation failures detected."
  else
    echo "READY_FOR_REVIEW=no"
    echo "Fix validation failures before approval."
  fi

  echo
  echo "No commit, tag, push, or destructive action was performed."
  echo "Human approval required before release."
} | tee "$REPORT"

echo
echo "Report saved to: $REPORT"
