#!/usr/bin/env python3

import subprocess
import sys
from pathlib import Path

BASE = Path("/home/gravesab/ai/projects/openclaw")
UPDATE_SCRIPT = BASE / "tools/property_manager/propertymanager-update.py"
SUMMARY_SCRIPT = BASE / "tools/property_manager/propertymanager-summary.sh"
BACKUP_SCRIPT = BASE / "tools/system_manager/openclaw-backup-manager.sh"
TM_REPORT_SCRIPT = BASE / "tools/system_manager/m4-timemachine-report.sh"
DAILY_BRIEFING_SCRIPT = BASE / "tools/briefing/daily-executive-briefing.sh"
DAILY_BRIEFING_DIR = BASE / "reports/daily-briefings"

HELP_MSG = """🌳 PropertyManager Commands

Backup / Ranch Bot:
• backup status
• backup now
• smart backup
• tm status
• time machine status

Status:
• property status
• property due
• property overdue
• property help

Pool:
• pool water test done
• pool filter done
• pool backwash done
• pool skimmer cleaned
• pool shock done

Hot Tub:
• hot tub water test done
• hot tub filter cleaned
• hot tub shock done
• hot tub shocked
• hot tub drained

Tractor:
• tractor inspection done
• tractor oil changed
• tractor tire pressure done
• tractor hydraulic fluid checked
• tractor hydraulic fluid changed
• tractor belt checked
• bucket grease done
• wheel grease done
• under tractor grease done"""


RANCH_HELP_MSG = """🌳 OpenClaw Ranch Bot Commands

Daily / Status:
• ranch status
• ranch briefing
• daily briefing
• system status

Backups:
• backup status
• smart backup
• backup now

Time Machine:
• tm status
• time machine status

PropertyManager:
• property status
• property due
• property overdue
• property help

Tip:
Ranch Bot now acknowledges commands before running them.
"""


def normalize(text: str) -> str:
    normalized = text.lower().strip()

    # Normalize Telegram slash commands. This also handles commands such as
    # /status@OpenClawRanchBot when used in a Telegram group.
    if normalized.startswith("/"):
        parts = normalized.split(maxsplit=1)
        slash_command = parts[0][1:].split("@", 1)[0]
        arguments = parts[1].strip() if len(parts) > 1 else ""

        slash_aliases = {
            "start": "ranch help",
            "help": "ranch help",
            "commands": "ranch help",

            "status": "ranch status",
            "ranchstatus": "ranch status",
            "systemstatus": "system status",

            "property": "property status",
            "propertystatus": "property status",
            "propertyhelp": "property help",
            "due": "property due",
            "overdue": "property overdue",

            "briefing": "daily briefing",
            "dailybriefing": "daily briefing",

            "backup": "backup status",
            "backupstatus": "backup status",
            "backupnow": "backup now",
            "smartbackup": "smart backup",

            "tmstatus": "tm status",
            "timemachinestatus": "time machine status",
        }

        normalized = slash_aliases.get(
            slash_command,
            f"{slash_command} {arguments}".strip(),
        )

    # PropertyManager help must remain distinct from general Ranch Bot help.
    if normalized in [
        "property help",
        "pm help",
        "help property",
        "propertymanager help",
    ]:
        return "property help"

    if normalized == "help":
        return "ranch help"

    for prefix in ["property ", "pm "]:
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):].strip()

    return normalized



def latest_daily_briefing() -> str:
    files = sorted(
        DAILY_BRIEFING_DIR.glob("daily-executive-briefing-*.txt"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    if not files:
        return run_daily_briefing()

    latest = files[0]
    return latest.read_text(errors="replace").strip()


def run_daily_briefing() -> str:
    result = subprocess.run(
        [str(DAILY_BRIEFING_SCRIPT)],
        text=True,
        capture_output=True,
        timeout=180,
    )
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return "⚠️ Daily Executive Briefing failed\n\n" + output

    return "✅ Daily Executive Briefing generated and sent to Telegram.\n\n" + output


def run_tm_status() -> str:
    result = subprocess.run(
        [str(TM_REPORT_SCRIPT)],
        text=True,
        capture_output=True,
        timeout=60,
    )
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return "⚠️ M4 Time Machine status command failed\n\n" + output
    return output

def run_backup(mode: str) -> str:
    result = subprocess.run(
        [str(BACKUP_SCRIPT), mode],
        text=True,
        capture_output=True,
        timeout=1800,
    )
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return "⚠️ OpenClaw backup command failed\n\n" + output
    return output

def run_summary() -> str:
    result = subprocess.run(
        [str(SUMMARY_SCRIPT)],
        text=True,
        capture_output=True,
        timeout=30,
    )
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return "⚠️ PropertyManager summary failed\n\n" + output
    return output

def run_update(command: str) -> str:
    result = subprocess.run(
        [str(UPDATE_SCRIPT), command],
        text=True,
        capture_output=True,
        timeout=30,
    )
    output = (result.stdout or result.stderr or "").strip()

    if result.returncode == 0:
        return "🌳 PropertyManager\n\n" + output

    if "Unknown PropertyManager command" in output:
        return "🌳 PropertyManager\n\nUnknown command.\n\nSend: property help"

    return "⚠️ PropertyManager command failed\n\n" + output

def main() -> int:
    raw = " ".join(sys.argv[1:]).strip()
    command = normalize(raw)

    if not command:
        print("🌳 PropertyManager\n\nSend: property help")
        return 0

    if command in ["ranch help", "openclaw help", "system help"]:
        print(RANCH_HELP_MSG)
        return 0

    if command == "help":
        print(RANCH_HELP_MSG)
        return 0

    if command == "property help":
        print(HELP_MSG)
        return 0

    if command in [
        "tm status", "time machine status", "timemachine status", "m4 backup status",
        "time machine", "tm", "qnap backup status"
    ]:
        print(run_tm_status())
        return 0

    if command in [
        "backup status", "backup", "system backup status",
        "openclaw backup status", "ranch backup status", "full backup status"
    ]:
        print(run_backup("status"))
        return 0

    if command in [
        "backup now", "run backup", "start backup", "system backup now",
        "run openclaw backup", "start openclaw backup", "full backup now"
    ]:
        print(run_backup("now"))
        return 0

    if command in [
        "smart backup", "backup smart", "check backup",
        "should i backup", "do i need a backup", "check openclaw backup"
    ]:
        print(run_backup("smart"))
        return 0

    if command in [
        "status", "summary", "due", "today", "overdue",
        "property status", "property summary", "property due", "property today", "property overdue",
        "property status", "property summary", "property due", "property today", "property overdue"
    ]:
        print(run_summary())
        return 0

    # Ranch/OpenClaw briefing routes.
    # Use exact and contains-style matching so Telegram mentions or extra words
    # do not fall through to the AI/chat fallback.
    if (
        command in [
            "daily briefing", "briefing", "executive briefing", "openclaw briefing",
            "ranch briefing", "morning briefing", "ranch report"
        ]
        or ("ranch" in command and ("briefing" in command or "status" in command or "report" in command))
        or ("openclaw" in command and ("briefing" in command or "status" in command or "report" in command))
    ):
        print(run_daily_briefing())
        return 0

    if command in ["ranch status", "system status"]:
        print(latest_daily_briefing())
        return 0

    # Safety: never let ranch/openclaw operational requests fall into AI fallback.
    if "ranch" in command or "openclaw" in command:
        print("🌳 OpenClaw Ranch Bot\n\nI recognized this as a Ranch/OpenClaw request, but I do not have a safe route for it yet.\n\nTry one of these:\n• ranch status\n• ranch briefing\n• backup status\n• smart backup\n• tm status")
        return 0

    print(run_update(command))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
