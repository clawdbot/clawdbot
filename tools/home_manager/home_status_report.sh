#!/usr/bin/env bash
set -euo pipefail

echo "=============================="
echo "OpenClaw AI Infrastructure Report"
echo "=============================="
echo

echo "Host:"
hostname
hostname -I
echo

echo "Date:"
date
echo

echo "=============================="
echo "OpenClaw Gateway"
echo "=============================="
systemctl --user --no-pager --lines=15 status openclaw-gateway.service || true
echo

echo "=============================="
echo "Voice Service"
echo "=============================="
systemctl --user --no-pager --lines=15 status openclaw-voice.service || true
echo

echo "=============================="
echo "Dashboard"
echo "=============================="
systemctl --user --no-pager --lines=15 status openclaw-dashboard.service || true
echo

echo "=============================="
echo "Docker Containers"
echo "=============================="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo

echo "=============================="
echo "M4 Ollama"
echo "=============================="
~/ai/projects/openclaw/tools/ollama/ollama_status.sh || true
echo

echo "=============================="
echo "AI Benchmark"
echo "=============================="
~/ai/projects/openclaw/tools/ollama/ollama_benchmark.sh || true
echo

echo "=============================="
echo "Scrypted"
echo "=============================="
~/ai/projects/openclaw/tools/scrypted/scrypted_status.sh || true
echo

echo "=============================="
echo "Disk Usage"
echo "=============================="
df -h /
echo

echo "=============================="
echo "Memory"
echo "=============================="
free -h
echo
