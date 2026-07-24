#!/usr/bin/env bash
set -euo pipefail

TREND_FILE="$HOME/ai/projects/openclaw/reports/trends.csv"

if [ ! -f "$TREND_FILE" ]; then
  echo "No trend data found."
  exit 0
fi

LATEST="$(tail -1 "$TREND_FILE")"

timestamp="$(echo "$LATEST" | cut -d',' -f1 | tr -d '"')"
latency="$(echo "$LATEST" | cut -d',' -f2)"
mem_used="$(echo "$LATEST" | cut -d',' -f3)"
disk_used="$(echo "$LATEST" | cut -d',' -f5)"

avg_latency="$(awk -F',' 'NR>1 {sum+=$2; count++} END {if(count>0) printf "%.0f", sum/count; else print 0}' "$TREND_FILE")"

echo "Anomaly Check"
echo "Timestamp: $timestamp"
echo

echo "Latest Ollama latency: ${latency} ms"
echo "Average Ollama latency: ${avg_latency} ms"
echo "Memory used: ${mem_used} GiB"
echo "Disk used: ${disk_used}%"
echo

ALERTS=0

if [ "${latency%.*}" -gt 5000 ]; then
  echo "⚠ ALERT: Ollama latency above 5000 ms."
  ALERTS=$((ALERTS+1))
fi

if [ "${avg_latency%.*}" -gt 0 ] && [ "${latency%.*}" -gt $((avg_latency * 3)) ]; then
  echo "⚠ ALERT: Ollama latency is more than 3x average."
  ALERTS=$((ALERTS+1))
fi

if [ "${disk_used%.*}" -gt 80 ]; then
  echo "⚠ ALERT: Disk usage above 80%."
  ALERTS=$((ALERTS+1))
fi

if [ "${mem_used%.*}" -gt 50 ]; then
  echo "⚠ ALERT: Memory usage above 50 GiB."
  ALERTS=$((ALERTS+1))
fi

if [ "$ALERTS" -eq 0 ]; then
  echo "✅ No anomalies detected."
fi
