#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
STATE_DIR="$BASE/reports/property_manager/state"
OFFSET_FILE="$STATE_DIR/telegram_offset.txt"
LOG_FILE="$BASE/reports/property_manager/propertymanager-telegram.log"

mkdir -p "$STATE_DIR"

source /home/gravesab/.openclaw/credentials/telegram.env

OFFSET="$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)"

RESPONSE="$(
curl -s \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${OFFSET}&timeout=5"
)"

python3 - "$RESPONSE" "$OFFSET_FILE" "$LOG_FILE" <<'PY'
import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime

raw = sys.argv[1]
offset_file = Path(sys.argv[2])
log_file = Path(sys.argv[3])

BASE = Path("/home/gravesab/ai/projects/openclaw")
COMMAND_SCRIPT = BASE / "tools/router/openclaw-router.py"
SEND_TELEGRAM = BASE / "tools/telegram/send-telegram.sh"
ENV_FILE = Path("/home/gravesab/.openclaw/credentials/telegram.env")

def log(msg: str):
    log_file.open("a").write(f"{datetime.now()} {msg}\n")

def send(msg: str):
    # Telegram message limit is about 4096 chars.
    # Keep chunks smaller for safety.
    max_len = 3500
    msg = msg or ""
    chunks = [msg[i:i+max_len] for i in range(0, len(msg), max_len)] or [""]
    total = len(chunks)

    for idx, chunk in enumerate(chunks, start=1):
        if total > 1:
            chunk = f"Part {idx}/{total}\n\n" + chunk
        subprocess.run([str(SEND_TELEGRAM), chunk], check=False)

def allowed_chat_id() -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("TELEGRAM_CHAT_ID="):
            return line.split("=", 1)[1].strip()
    return ""

try:
    data = json.loads(raw)
except Exception as e:
    log_file.open("a").write(f"{datetime.now()} JSON error: {e}\n")
    raise SystemExit(0)

if not data.get("ok"):
    log_file.open("a").write(f"{datetime.now()} Telegram not ok: {raw}\n")
    raise SystemExit(0)

max_update_id = None
allowed_chat = allowed_chat_id()

# Fail closed if the authorized Telegram chat ID is missing.
if not allowed_chat:
    log("SECURITY ERROR: TELEGRAM_CHAT_ID is missing; no commands were processed.")
    raise SystemExit(0)

for update in data.get("result", []):
    update_id = update.get("update_id")
    if update_id is not None:
        max_update_id = update_id if max_update_id is None else max(max_update_id, update_id)

    msg = update.get("message") or {}
    text = (msg.get("text") or "").strip()

    chat = msg.get("chat") or {}
    sender = msg.get("from") or {}

    chat_id = str(chat.get("id", ""))
    chat_type = str(chat.get("type", "unknown"))
    username = str(sender.get("username") or chat.get("username") or "not provided")
    first_name = str(sender.get("first_name") or chat.get("first_name") or "")
    last_name = str(sender.get("last_name") or chat.get("last_name") or "")
    display_name = f"{first_name} {last_name}".strip() or "not provided"

    if not text:
        continue

    # Keep alerts readable and prevent excessively large commands from
    # flooding Telegram or the local security log.
    command_preview = text.replace("\n", " ")[:200]

    authorized = (
        chat_id == allowed_chat
        and chat_type == "private"
    )

    if not authorized:
        log(
            "SECURITY BLOCK "
            f"update_id={update_id} "
            f"chat_id={chat_id!r} "
            f"chat_type={chat_type!r} "
            f"username={username!r} "
            f"display_name={display_name!r} "
            f"command={command_preview!r}"
        )

        send(
            "⚠️ Unauthorized Telegram command blocked\n\n"
            f"Chat ID: {chat_id or 'not provided'}\n"
            f"Username: @{username if username != 'not provided' else 'not provided'}\n"
            f"Name: {display_name}\n"
            f"Chat type: {chat_type}\n"
            f"Command: {command_preview}\n\n"
            "No action was taken."
        )
        continue

    send(f"✅ Acknowledged. OpenClaw Ranch Bot is working on your request.\n\nCommand:\n{text}")

    try:
        result = subprocess.run(
            [str(COMMAND_SCRIPT), text],
            text=True,
            capture_output=True,
            timeout=1800,
        )

        output = (result.stdout or result.stderr or "").strip()

        if not output:
            output = "Command finished, but returned no message."

        send(output)

    except Exception as e:
        send(f"🚨 PropertyManager error\n\n{e}")

if max_update_id is not None:
    offset_file.write_text(str(max_update_id + 1))
PY
