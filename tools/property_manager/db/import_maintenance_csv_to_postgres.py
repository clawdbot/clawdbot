#!/usr/bin/env python3
import csv
import hashlib
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path("/home/gravesab/ai/projects/openclaw")
CSV_PATH = BASE / "tools/property_manager/maintenance_log.csv"

def stable_uuid(area: str, item: str) -> str:
    key = f"{area.strip().lower()}::{item.strip().lower()}"
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return str(uuid.UUID(digest))

def category_from_area(area: str) -> str:
    a = area.strip().lower()
    if "pool" in a:
        return "Pool"
    if "hot" in a or "tub" in a or "spa" in a:
        return "Hot Tub"
    if "tractor" in a:
        return "Tractor"
    if "ground" in a or "yard" in a or "tree" in a or "fence" in a:
        return "Grounds"
    if "safety" in a:
        return "Safety"
    if "equipment" in a:
        return "Equipment"
    return "House"

def frequency_from_days(warning_days: int) -> str:
    if warning_days <= 7:
        return "Weekly"
    if warning_days <= 14:
        return "Biweekly"
    if warning_days <= 31:
        return "Monthly"
    if warning_days <= 95:
        return "Quarterly"
    if warning_days <= 190:
        return "Semiannual"
    return "Annual"

def run_psql(sql: str) -> None:
    subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "openclaw", "-d", "openclaw", "-v", "ON_ERROR_STOP=1"],
        input=sql,
        text=True,
        check=True,
    )

if not CSV_PATH.exists():
    print(f"Missing CSV: {CSV_PATH}", file=sys.stderr)
    sys.exit(1)

rows = []
with CSV_PATH.open(newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        area = (row.get("area") or "").strip()
        item = (row.get("item") or "").strip()
        if not area or not item:
            continue

        warning_days = int(row.get("warning_days") or 30)
        critical_days = int(row.get("critical_days") or max(warning_days * 2, warning_days + 1))
        last_done_date = datetime.strptime(row.get("last_done"), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        next_due = last_done_date + timedelta(days=warning_days)

        rows.append({
            "id": stable_uuid(area, item),
            "area": area,
            "item": item,
            "category_name": category_from_area(area),
            "priority": "Medium",
            "frequency": frequency_from_days(warning_days),
            "warning_days": warning_days,
            "critical_days": critical_days,
            "last_done": last_done_date.isoformat(),
            "next_due": next_due.isoformat(),
        })

values = []
for r in rows:
    def q(v):
        return "'" + str(v).replace("'", "''") + "'"
    values.append(
        "(" + ",".join([
            q(r["id"]),
            q(r["area"]),
            q(r["item"]),
            q(r["category_name"]),
            q(r["priority"]),
            q(r["frequency"]),
            str(r["warning_days"]),
            str(r["critical_days"]),
            q(r["last_done"]),
            q(r["next_due"]),
            "now()",
        ]) + ")"
    )

sql = """
INSERT INTO propertymanager.maintenance_tasks
(id, area, item, category_name, priority, frequency, warning_days, critical_days, last_done, next_due, updated_at)
VALUES
""" + ",\n".join(values) + """
ON CONFLICT (area, item) DO UPDATE SET
    category_name = EXCLUDED.category_name,
    frequency = EXCLUDED.frequency,
    warning_days = EXCLUDED.warning_days,
    critical_days = EXCLUDED.critical_days,
    last_done = EXCLUDED.last_done,
    next_due = EXCLUDED.next_due,
    updated_at = now();
"""

run_psql(sql)
print(f"Imported/upserted {len(rows)} tasks from {CSV_PATH}")
