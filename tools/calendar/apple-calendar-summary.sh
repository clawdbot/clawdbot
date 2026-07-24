#!/usr/bin/env bash
set -euo pipefail

RAW_FILE="$(mktemp)"
trap 'rm -f "$RAW_FILE"' EXIT

osascript <<'APPLESCRIPT' > "$RAW_FILE"
use AppleScript version "2.4"
use scripting additions

set nowDate to current date
set todayStart to nowDate
set time of todayStart to 0
set tomorrowStart to todayStart + days
set dayAfterTomorrow to todayStart + (2 * days)
set weekEnd to todayStart + (7 * days)

set output to ""

tell application "Calendar"
    set calendarList to calendars
    repeat with cal in calendarList
        try
            set eventList to (every event of cal whose start date ≥ todayStart and start date < weekEnd)
            repeat with e in eventList
                set eventStart to start date of e
                set eventEnd to end date of e
                set eventSummary to summary of e
                set eventLocation to location of e

                set output to output & (eventStart as string) & "||" & (eventEnd as string) & "||" & eventSummary & "||" & eventLocation & linefeed
            end repeat
        end try
    end repeat
end tell

return output
APPLESCRIPT

python3 - "$RAW_FILE" <<'PY'
import sys
from datetime import datetime, timedelta
from pathlib import Path

raw = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").strip()

now = datetime.now()
today = datetime(now.year, now.month, now.day)
tomorrow = today + timedelta(days=1)
day_after_tomorrow = today + timedelta(days=2)
week_end = today + timedelta(days=7)


def parse_apple_date(text):
    # Example AppleScript date:
    # Wednesday, June 3, 2026 at 7:45:00 AM
    for fmt in [
        "%A, %B %d, %Y at %I:%M:%S %p",
        "%A, %B %d, %Y at %H:%M:%S",
        "%A, %B %d, %Y, %I:%M:%S %p",
        "%A, %B %d, %Y, %H:%M:%S",
    ]:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass

    # Fallback for some macOS locales with double spaces.
    cleaned = " ".join(text.replace(" at ", " ").split())

    for fmt in [
        "%A %B %d %Y %I:%M:%S %p",
        "%A %B %d %Y %H:%M:%S",
    ]:
        try:
            return datetime.strptime(cleaned, fmt)
        except ValueError:
            pass

    return None


events = []

for line in raw.splitlines():
    parts = line.split("||")

    if len(parts) < 3:
        continue

    start_raw = parts[0].strip()
    end_raw = parts[1].strip()
    title = parts[2].strip() or "(No title)"
    location = parts[3].strip() if len(parts) > 3 else ""

    start = parse_apple_date(start_raw)
    end = parse_apple_date(end_raw)

    if not start:
        continue

    # Hard filter: never show events before today's date.
    if start < today:
        continue

    if start >= week_end:
        continue

    all_day = (
        start.hour == 0
        and start.minute == 0
        and end is not None
        and end.hour == 0
        and end.minute == 0
        and (end - start).days >= 1
    )

    events.append(
        {
            "start": start,
            "end": end,
            "title": title,
            "location": location,
            "all_day": all_day,
        }
    )

events.sort(key=lambda event: event["start"])

today_events = [
    event for event in events
    if today <= event["start"] < tomorrow
]

tomorrow_events = [
    event for event in events
    if tomorrow <= event["start"] < day_after_tomorrow
]

week_events = [
    event for event in events
    if today <= event["start"] < week_end
]


def event_line(event):
    day = event["start"].strftime("%A, %B %-d")

    if event["all_day"]:
        when = f"{day} — All day"
    else:
        when = f"{day} — {event['start'].strftime('%H:%M')}"

    text = f"• {when} — {event['title']}"

    if event["location"]:
        text += f" @ {event['location']}"

    return text


def show_section(title, items, limit):
    print(title)

    if not items:
        print("• None")
        print()
        return

    for event in items[:limit]:
        print(event_line(event))

    print()


print("📅 CalendarManager")
print(now.strftime("%A, %B %-d, %Y %H:%M"))
print()
print(f"Today: {len(today_events)}")
print(f"Tomorrow: {len(tomorrow_events)}")
print(f"Next 7 Days: {len(week_events)}")
print()

show_section("Today’s Appointments", today_events, 8)
show_section("Tomorrow’s Appointments", tomorrow_events, 8)
show_section("This Week’s Appointments", week_events, 12)
PY
