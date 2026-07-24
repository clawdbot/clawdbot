#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime, timedelta, timezone
import subprocess
import os

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

BASE = Path.home() / "ai/projects/openclaw"
REPORT_DIR = BASE / "reports/calendar"
REPORT_DIR.mkdir(parents=True, exist_ok=True)

TOKEN_FILE = Path.home() / ".openclaw" / "credentials" / "calendar-token.json"
SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

LOCAL_TZ = timezone(timedelta(hours=-5))

def fmt_event_time(start, end):
    s = start.get("dateTime") or start.get("date")
    e = end.get("dateTime") or end.get("date")

    if "T" not in s:
        return "All day"

    try:
        ds = datetime.fromisoformat(s.replace("Z", "+00:00"))
        de = datetime.fromisoformat(e.replace("Z", "+00:00"))
        return f"{ds.strftime('%I:%M %p').lstrip('0')} - {de.strftime('%I:%M %p').lstrip('0')}"
    except Exception:
        return s

def get_events(service, start_dt, end_dt, max_results=20):
    events_result = service.events().list(
        calendarId="primary",
        timeMin=start_dt.isoformat(),
        timeMax=end_dt.isoformat(),
        singleEvents=True,
        orderBy="startTime",
        maxResults=max_results,
    ).execute()

    return events_result.get("items", [])

def section(title, events):
    lines = []
    lines.append(title)

    if not events:
        lines.append("• None")
        lines.append("")
        return lines

    for event in events:
        summary = event.get("summary", "(No title)")
        when = fmt_event_time(event.get("start", {}), event.get("end", {}))
        location = event.get("location", "")

        if location:
            lines.append(f"• {when} — {summary} @ {location}")
        else:
            lines.append(f"• {when} — {summary}")

    lines.append("")
    return lines

if not TOKEN_FILE.exists():
    print("Calendar token missing. Run:")
    print("python3 /home/gravesab/ai/projects/openclaw/tools/calendar/calendar_auth.py")
    raise SystemExit(1)

creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
service = build("calendar", "v3", credentials=creds)

now = datetime.now().astimezone()
today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow_start = today_start + timedelta(days=1)
day_after_tomorrow = today_start + timedelta(days=2)
week_end = today_start + timedelta(days=7)

today_events = get_events(service, today_start, tomorrow_start)
tomorrow_events = get_events(service, tomorrow_start, day_after_tomorrow)
week_events = get_events(service, today_start, week_end, max_results=40)

lines = []
lines.append("📅 CalendarManager")
lines.append(now.strftime("%A, %B %d, %Y %I:%M %p"))
lines.append("")
lines.append(f"Today: {len(today_events)}")
lines.append(f"Tomorrow: {len(tomorrow_events)}")
lines.append(f"Next 7 Days: {len(week_events)}")
lines.append("")

lines.extend(section("Today’s Appointments", today_events))
lines.extend(section("Tomorrow’s Appointments", tomorrow_events))
lines.extend(section("This Week’s Appointments", week_events[:12]))

report = "\n".join(lines)

report_file = REPORT_DIR / f"calendarmanager-summary-{now.strftime('%Y%m%d-%H%M%S')}.txt"
report_file.write_text(report)

print(report)
print("")
print(f"Saved report: {report_file}")
