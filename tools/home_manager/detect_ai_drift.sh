#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="$HOME/ai/projects/openclaw/reports"
LATEST_SUMMARY="$(ls -t "$REPORT_DIR"/home_ai_summary_*.txt | head -1)"

echo "AI Drift Check"
echo "Latest summary: $LATEST_SUMMARY"
echo

TEXT="$(cat "$LATEST_SUMMARY")"

CRITICAL_MATCHES="$(echo "$TEXT" | grep -Ein \
'failed|failure|offline|not running|critical|degraded|unreachable|crashed|panic|corruption|timeout|refused|service down' || true)"

SAFE_MATCHES="$(echo "$TEXT" | grep -Ein \
'no service is failing|no critical issues|healthy|running normally|acceptable|within limits|stable' || true)"

if [ -n "$CRITICAL_MATCHES" ]; then
  echo "⚠ Possible drift or degradation detected:"
  echo "$CRITICAL_MATCHES"
  exit 0
fi

if [ -n "$SAFE_MATCHES" ]; then
  echo "✅ AI summary indicates healthy/stable operation."
  echo
  echo "$SAFE_MATCHES"
  exit 0
fi

echo "✅ No concerning AI drift wording detected."
