#!/usr/bin/env python3

"""
OpenClaw Ranch Bot rule-based router.

Responsibilities:
1. Recognize known Telegram slash commands.
2. Recognize common natural-language requests.
3. Convert them to commands understood by the existing backend.
4. Pass unknown conversational requests unchanged to the current AI fallback.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


BASE = Path("/home/gravesab/ai/projects/openclaw")

BACKEND = (
    BASE
    / "tools/property_manager/propertymanager-telegram-command.py"
)

CHAT_AGENT = (
    BASE
    / "tools/chat_agent/chat_agent.py"
)

CHAT_PYTHON = Path(
    "/home/gravesab/ai/projects/openclaw/.venv/bin/python"
)

RANCHBRAIN = (
    BASE
    / "tools/ranchbrain/ranchbrain.py"
)

RANCHBRAIN_REVIEW = (
    BASE
    / "tools/ranchbrain/ranchbrain-review.py"
)

AI_ADVISOR = (
    BASE
    / "tools/ai_intelligence/advisory_route.py"
)


EXACT_ROUTES: dict[str, str] = {
    # RanchBrain
    "/ranchbrain": "ranchbrain status",
    "/brainstatus": "ranchbrain status",
    "ranchbrain": "ranchbrain status",
    "ranchbrain status": "ranchbrain status",
    "brain status": "ranchbrain status",

    # General help
    "/start": "ranch help",
    "/help": "ranch help",
    "/commands": "ranch help",
    "help": "ranch help",
    "show commands": "ranch help",

    # Overall OpenClaw status
    "/status": "ranch status",
    "/ranchstatus": "ranch status",
    "/systemstatus": "system status",
    "ranch status": "ranch status",
    "system status": "system status",
    "openclaw status": "ranch status",

    # PropertyManager
    "/tasks": "property status",
    "/task": "property status",
    "/property": "property status",
    "/propertystatus": "property status",
    "/propertyhelp": "property help",
    "/due": "property due",
    "/overdue": "property overdue",
    "tasks": "property status",
    "show tasks": "property status",
    "property tasks": "property status",
    "property status": "property status",
    "property help": "property help",

    # Briefing
    "/briefing": "daily briefing",
    "/dailybriefing": "daily briefing",
    "daily briefing": "daily briefing",
    "morning briefing": "daily briefing",
    "ranch briefing": "ranch briefing",

    # Backups
    "/backup": "backup status",
    "/backupstatus": "backup status",
    "/backupnow": "backup now",
    "/smartbackup": "smart backup",
    "backup status": "backup status",
    "smart backup": "smart backup",

    # Time Machine
    "/tmstatus": "tm status",
    "/timemachinestatus": "time machine status",
    "tm status": "tm status",
    "time machine status": "time machine status",
}


PROPERTY_PATTERNS = [
    r"\b(show|list|display)\b.*\b(tasks?|chores?|maintenance)\b",
    r"\bwhat(?:'s| is)\b.*\b(due|overdue)\b",
    r"\bwhat\b.*\bneeds? (?:my )?attention\b",
    r"\bwhat should i (?:do|work on)\b",
    r"\bwhat needs to be done\b",
    r"\bproperty\b.*\b(status|tasks?|due|overdue)\b",
    r"\bmaintenance\b.*\b(status|due|overdue)\b",
]

OVERDUE_PATTERNS = [
    r"\bwhat(?:'s| is)\b.*\boverdue\b",
    r"\bshow\b.*\boverdue\b",
    r"\blist\b.*\boverdue\b",
]

DUE_PATTERNS = [
    r"\bwhat(?:'s| is)\b.*\bdue today\b",
    r"\bshow\b.*\bdue today\b",
    r"\btoday(?:'s)? tasks?\b",
]

BACKUP_STATUS_PATTERNS = [
    r"\bhow are\b.*\bbackups?\b",
    r"\bbackup\b.*\bstatus\b",
    r"\bwhen was\b.*\blast backup\b",
    r"\bdid\b.*\bbackup\b.*\brun\b",
    r"\bare my backups? (?:current|healthy|okay|ok)\b",
]

SMART_BACKUP_PATTERNS = [
    r"\bdo i need\b.*\bbackup\b",
    r"\bshould i\b.*\bbackup\b",
    r"\bcheck\b.*\bbackup\b",
    r"\brun\b.*\bsmart backup\b",
]

TIME_MACHINE_PATTERNS = [
    r"\btime machine\b.*\b(status|backup|current|healthy|run)\b",
    r"\bdid time machine\b.*\brun\b",
    r"\bwhen was\b.*\btime machine\b",
    r"\bhow is\b.*\btime machine\b",
]

BRIEFING_PATTERNS = [
    r"\b(generate|run|send|show|give me)\b.*\bbriefing\b",
    r"\bmorning briefing\b",
    r"\bdaily executive briefing\b",
    r"\branch briefing\b",
]

RANCH_STATUS_PATTERNS = [
    r"\bhow is openclaw\b",
    r"\bhow are my systems?\b",
    r"\bopenclaw\b.*\b(status|health|healthy)\b",
    r"\bsystem\b.*\b(status|health|healthy)\b",
    r"\branch\b.*\b(status|health|report)\b",
]


def clean_text(text: str) -> str:
    """Normalize whitespace and Telegram bot mentions."""

    normalized = text.strip().lower()
    normalized = re.sub(r"\s+", " ", normalized)

    # Convert /command@bot_username into /command.
    if normalized.startswith("/"):
        first, *rest = normalized.split(maxsplit=1)
        first = first.split("@", 1)[0]
        normalized = " ".join([first, *rest]).strip()

    return normalized


def matches_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def route(text: str) -> tuple[str, str]:
    """
    Return:
        routed command
        route name
    """

    normalized = clean_text(text)

    # RanchBrain capture, review, approval, and rejection.
    if normalized.startswith("/brainaddforce "):
        note = normalized.removeprefix(
            "/brainaddforce "
        ).strip()

        return (
            "capture force " + note,
            "ranchbrain-review",
        )

    if normalized.startswith("/brainadd "):
        note = normalized.removeprefix(
            "/brainadd "
        ).strip()

        return (
            "capture " + note,
            "ranchbrain-review",
        )

    if normalized.startswith("brain add force "):
        note = normalized.removeprefix(
            "brain add force "
        ).strip()

        return (
            "capture force " + note,
            "ranchbrain-review",
        )

    if normalized.startswith("brain add "):
        note = normalized.removeprefix(
            "brain add "
        ).strip()

        return (
            "capture " + note,
            "ranchbrain-review",
        )

    if normalized in {
        "/brainreview",
        "brain review",
        "review ranchbrain",
    }:
        return "review", "ranchbrain-review"

    if normalized.startswith("/brainapprove "):
        memory_id = normalized.removeprefix(
            "/brainapprove "
        ).strip()

        return (
            "approve " + memory_id,
            "ranchbrain-review",
        )

    if normalized.startswith("brain approve "):
        memory_id = normalized.removeprefix(
            "brain approve "
        ).strip()

        return (
            "approve " + memory_id,
            "ranchbrain-review",
        )

    if normalized.startswith("/brainreject "):
        memory_id = normalized.removeprefix(
            "/brainreject "
        ).strip()

        return (
            "reject " + memory_id,
            "ranchbrain-review",
        )

    if normalized.startswith("brain reject "):
        memory_id = normalized.removeprefix(
            "brain reject "
        ).strip()

        return (
            "reject " + memory_id,
            "ranchbrain-review",
        )

    # RanchBrain commands with user-provided text.
    if normalized.startswith("/brainaddforce "):
        note = normalized.removeprefix("/brainaddforce ").strip()

        return (
            "add force " + note,
            "ranchbrain-action",
        )

    if normalized.startswith("brain add force "):
        note = normalized.removeprefix("brain add force ").strip()

        return (
            "add force " + note,
            "ranchbrain-action",
        )

    ranchbrain_prefixes = {
        "/brainadd ": "add ",
        "brain add ": "add ",
        "/brainsearch ": "search ",
        "brain search ": "search ",
    }

    for prefix, command_prefix in ranchbrain_prefixes.items():
        if normalized.startswith(prefix):
            remainder = text.strip()[len(prefix):].strip()
            return (
                command_prefix + remainder,
                "ranchbrain-action",
            )

    if normalized.startswith("/brainask "):
        question = normalized.removeprefix("/brainask ").strip()

        return (
            "ask " + question,
            "ranchbrain-action",
        )

    if normalized.startswith("brain ask "):
        question = normalized.removeprefix("brain ask ").strip()

        return (
            "ask " + question,
            "ranchbrain-action",
        )

    if normalized in {
        "/brainlist",
        "brain list",
    }:
        return "list", "ranchbrain-action"

    if normalized in {
        "/brainhelp",
        "brain help",
    }:
        return "help", "ranchbrain-action"

    if normalized in EXACT_ROUTES:
        command = EXACT_ROUTES[normalized]

        if command == "ranchbrain status":
            return command, "ranchbrain-status"

        return command, "exact-rule"

    # More-specific PropertyManager routes must run before general task rules.
    if matches_any(normalized, OVERDUE_PATTERNS):
        return "property overdue", "property-overdue"

    if matches_any(normalized, DUE_PATTERNS):
        return "property due", "property-due"

    if matches_any(normalized, PROPERTY_PATTERNS):
        return "property status", "property-status"

    if matches_any(normalized, SMART_BACKUP_PATTERNS):
        return "smart backup", "smart-backup"

    if matches_any(normalized, BACKUP_STATUS_PATTERNS):
        return "backup status", "backup-status"

    if matches_any(normalized, TIME_MACHINE_PATTERNS):
        return "tm status", "time-machine"

    if matches_any(normalized, BRIEFING_PATTERNS):
        return "daily briefing", "briefing"

    if matches_any(normalized, RANCH_STATUS_PATTERNS):
        return "ranch status", "ranch-status"

    # Unknown input is deliberately preserved for the existing AI fallback.
    return text.strip(), "ai-fallback"


def run_chat_agent(question: str) -> int:
    # Advisory mode records the model RanchBrain recommends without
    # changing the current production ChatAgent model.
    if AI_ADVISOR.is_file() and CHAT_PYTHON.is_file():
        try:
            subprocess.run(
                [
                    str(CHAT_PYTHON),
                    str(AI_ADVISOR),
                    question,
                ],
                text=True,
                capture_output=True,
                timeout=15,
                check=False,
            )
        except Exception:
            # Advisory routing must never interrupt the working bot.
            pass

    if not CHAT_AGENT.is_file():
        print(
            "🚨 OpenClaw Router error\n\n"
            f"ChatAgent not found: {CHAT_AGENT}"
        )
        return 1

    if not CHAT_PYTHON.is_file():
        print(
            "🚨 OpenClaw Router error\n\n"
            f"ChatAgent Python environment not found: {CHAT_PYTHON}"
        )
        return 1

    try:
        result = subprocess.run(
            [str(CHAT_PYTHON), str(CHAT_AGENT), question],
            text=True,
            capture_output=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        print("⚠️ OpenClaw AI timed out while answering.")
        return 1
    except Exception as exc:
        print(
            "🚨 OpenClaw Router error\n\n"
            f"{exc}"
        )
        return 1

    output = (result.stdout or "").strip()
    error = (result.stderr or "").strip()

    if output:
        print(output)
    elif error:
        print("⚠️ OpenClaw AI failed\n\n" + error)
    else:
        print("The AI returned no response.")

    return result.returncode


def run_ranchbrain_review(command: str) -> int:
    if not RANCHBRAIN_REVIEW.is_file():
        print(
            "🚨 OpenClaw Router error\n\n"
            f"RanchBrain review tool not found: "
            f"{RANCHBRAIN_REVIEW}"
        )
        return 1

    try:
        result = subprocess.run(
            [
                str(CHAT_PYTHON),
                str(RANCHBRAIN_REVIEW),
                command,
            ],
            text=True,
            capture_output=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        print(
            "⚠️ RanchBrain review command timed out."
        )
        return 1
    except Exception as exc:
        print(
            "🚨 OpenClaw Router error\n\n"
            f"{exc}"
        )
        return 1

    output = (
        result.stdout
        or result.stderr
        or ""
    ).strip()

    if output:
        print(output)
    else:
        print(
            "RanchBrain review returned no response."
        )

    return result.returncode


def run_ranchbrain(command: str) -> int:
    if not RANCHBRAIN.is_file():
        print(
            "🚨 OpenClaw Router error\n\n"
            f"RanchBrain tool not found: {RANCHBRAIN}"
        )
        return 1

    try:
        result = subprocess.run(
            [
                str(CHAT_PYTHON),
                str(RANCHBRAIN),
                command,
            ],
            text=True,
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        print(
            "⚠️ RanchBrain status timed out."
        )
        return 1
    except Exception as exc:
        print(
            "🚨 OpenClaw Router error\n\n"
            f"{exc}"
        )
        return 1

    output = (result.stdout or result.stderr or "").strip()

    if output:
        print(output)
    else:
        print("RanchBrain returned no response.")

    return result.returncode


def run_backend(command: str) -> int:
    if not BACKEND.is_file():
        print(
            f"🚨 OpenClaw Router error\n\n"
            f"Backend not found: {BACKEND}"
        )
        return 1

    try:
        result = subprocess.run(
            [str(BACKEND), command],
            text=True,
            capture_output=True,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        print(
            "🚨 OpenClaw Router error\n\n"
            "The routed command timed out."
        )
        return 1
    except Exception as exc:
        print(
            "🚨 OpenClaw Router error\n\n"
            f"{exc}"
        )
        return 1

    output = (result.stdout or result.stderr or "").strip()

    if output:
        print(output)
    else:
        print("Command finished, but returned no message.")

    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Route Ranch Bot commands to OpenClaw subsystems."
    )
    parser.add_argument(
        "--route-only",
        action="store_true",
        help="Show the route without executing the backend.",
    )
    parser.add_argument(
        "message",
        nargs="*",
        help="Incoming Telegram message.",
    )

    args = parser.parse_args()
    raw = " ".join(args.message).strip()

    if not raw:
        raw = sys.stdin.read().strip()

    if not raw:
        print("ranch help")
        return 0

    command, route_name = route(raw)

    if args.route_only:
        print(
            f"input={raw!r}\n"
            f"route={route_name!r}\n"
            f"command={command!r}"
        )
        return 0

    if route_name == "ranchbrain-review":
        return run_ranchbrain_review(command)

    if route_name in {
        "ranchbrain-status",
        "ranchbrain-action",
    }:
        return run_ranchbrain(command)

    if route_name == "ai-fallback":
        # Unknown slash commands must never be sent to the language model.
        if clean_text(raw).startswith("/"):
            print(
                "🌳 OpenClaw Ranch Bot\n\n"
                "Unknown command. Send /help to see available commands."
            )
            return 0

        return run_chat_agent(raw)

    return run_backend(command)


if __name__ == "__main__":
    raise SystemExit(main())
