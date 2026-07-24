#!/usr/bin/env bash
set -euo pipefail

cd /home/gravesab/ai/projects/openclaw/tools/gmail
source .venv/bin/activate

python3 /home/gravesab/ai/projects/openclaw/tools/mailmanager/mailmanager2-summary.py
