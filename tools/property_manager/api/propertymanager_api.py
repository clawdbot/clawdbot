#!/usr/bin/env python3
from flask import Flask, jsonify
import psycopg2
import psycopg2.extras

app = Flask(__name__)

DB_CONFIG = {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "openclaw",
    "user": "openclaw",
    "password": "openclaw",
}

def db():
    return psycopg2.connect(**DB_CONFIG)

@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "propertymanager-api"})

@app.get("/categories")
def categories():
    with db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, icon, color_name, is_built_in, sort_order
                FROM propertymanager.maintenance_categories
                ORDER BY sort_order, name
            """)
            return jsonify(cur.fetchall())

@app.get("/tasks")
def tasks():
    with db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT
                    id, area, item, category_name, priority, frequency,
                    task_description, response_instructions, supplies_needed,
                    notes, result_notes, estimated_minutes,
                    warning_days, critical_days,
                    last_done, next_due,
                    send_telegram_update, include_in_daily_briefing,
                    alert_if_overdue, is_active,
                    part_url, vendor, part_number, part_cost, annual_cost,
                    created_at, updated_at
                FROM propertymanager.maintenance_tasks
                WHERE is_active = true
                ORDER BY area, item
            """)
            rows = cur.fetchall()
            for row in rows:
                for key, value in list(row.items()):
                    if hasattr(value, "isoformat"):
                        row[key] = value.isoformat()
                    elif value is not None and key in ("part_cost", "annual_cost"):
                        row[key] = float(value)
            return jsonify(rows)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5062, debug=True)
