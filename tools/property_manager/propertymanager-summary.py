#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime
import csv

BASE = Path.home() / "ai/projects/openclaw"
TASK_FILE = BASE / "tools/property_manager/property_tasks.csv"
MAINT_FILE = BASE / "tools/property_manager/maintenance_log.csv"
REPORT_DIR = BASE / "reports/property_manager"
REPORT_DIR.mkdir(parents=True, exist_ok=True)

now = datetime.now()
month = now.month
weekday = now.strftime("%A")
day = now.day

def month_active(months_text):
    months_text = (months_text or "").strip()
    if not months_text or months_text == "1-12":
        return True
    for part in months_text.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            if int(a) <= month <= int(b):
                return True
        elif part and int(part) == month:
            return True
    return False

def due_today(row):
    if not month_active(row.get("months", "")):
        return False

    freq = row.get("frequency", "").lower()
    hint = row.get("day_hint", "")

    if freq == "daily":
        return True
    if freq == "weekly":
        return hint.lower() == weekday.lower()
    if freq == "monthly":
        if "first" in hint.lower():
            wanted = hint.lower().replace("first", "").strip()
            return day <= 7 and wanted == weekday.lower()
        return day == 1
    if freq == "quarterly":
        return month in [1, 4, 7, 10] and day <= 7

    if freq == "yearly":
        return month == 1 and day <= 7

    return False

def days_since(date_text):
    try:
        d = datetime.strptime(date_text, "%Y-%m-%d")
        return (now.date() - d.date()).days
    except Exception:
        return None

def status_for(days, warning, critical):
    if days is None:
        return "🚨 Unknown"
    if days >= critical:
        return "🚨 Critical"
    if days >= warning:
        return "⚠️ Due soon"
    return "✅ OK"

tasks = []
if TASK_FILE.exists():
    with TASK_FILE.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if due_today(row):
                tasks.append(row)

high = [t for t in tasks if t.get("priority") == "high"]
normal = [t for t in tasks if t.get("priority") != "high"]

maintenance = []
if MAINT_FILE.exists():
    with MAINT_FILE.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            days = days_since(row.get("last_done", ""))
            warning = int(row.get("warning_days", 999))
            critical = int(row.get("critical_days", 999))
            status = status_for(days, warning, critical)

            # Only show maintenance items that need attention.
            # Suppress OK/not-due items like annual tractor hydraulic fluid change.
            if status == "✅ OK":
                continue

            maintenance.append({
                "area": row.get("area", ""),
                "item": row.get("item", ""),
                "last_done": row.get("last_done", ""),
                "days": days,
                "status": status,
            })

lines = []
lines.append("🌳 PropertyManager")
lines.append(now.strftime("%A, %B %d, %Y"))
lines.append("")
lines.append(f"Tasks due today: {len(tasks)}")
lines.append(f"High priority: {len(high)}")
lines.append("")

lines.append("Maintenance Status")
if not maintenance:
    lines.append("• No maintenance tracking file found.")
else:
    for m in maintenance:
        days_text = "unknown" if m["days"] is None else f"{m['days']} days ago"
        lines.append(f"• {m['status']} {m['area']}: {m['item']} — last done {days_text}")
lines.append("")

if high:
    lines.append("High Priority")
    for t in high:
        lines.append(f"• {t['category']}: {t['item']}")
    lines.append("")

if normal:
    lines.append("Normal")
    for t in normal[:10]:
        lines.append(f"• {t['category']}: {t['item']}")
    lines.append("")

if not tasks:
    lines.append("No property tasks due today.")
    lines.append("")

report = "\n".join(lines)

report_file = REPORT_DIR / f"propertymanager-summary-{now.strftime('%Y%m%d-%H%M%S')}.txt"
report_file.write_text(report)

print(report)
print("")
print(f"Saved report: {report_file}")
