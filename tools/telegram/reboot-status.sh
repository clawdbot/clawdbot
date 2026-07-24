#!/usr/bin/env bash

OPENCLAW_STATUS="unknown"

cd /home/gravesab/ai/projects/openclaw

if pnpm openclaw status --deep >/tmp/openclaw-telegram-status.txt 2>&1; then
  OPENCLAW_STATUS="healthy"
else
  OPENCLAW_STATUS="problem"
fi

MSG="OpenClaw Reboot Status

OpenClaw: $OPENCLAW_STATUS
Dashboard: $(systemctl is-active openclaw-dashboard.service)
Listener: $(systemctl is-active openclaw-listener.service)
Docker: $(systemctl is-active docker)

Dashboard URL:
http://100.85.36.72:5051

Home Assistant:
http://100.85.36.72:8123

Time: $(date)"

/home/gravesab/ai/projects/openclaw/tools/telegram/send-telegram.sh "$MSG"
