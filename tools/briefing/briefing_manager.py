import json
import os
import redis
import psycopg2
from datetime import datetime

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    decode_responses=True
)

DB = {
    "host": os.environ.get("OPENCLAW_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("OPENCLAW_DB_PORT", "5432")),
    "dbname": os.environ.get("OPENCLAW_DB_NAME", "openclaw"),
    "user": os.environ.get("OPENCLAW_DB_USER", "openclaw"),
    "password": os.environ.get("OPENCLAW_DB_PASSWORD"),
}

def get_recent_events():
    raw = r.lrange("openclaw:events", 0, 10)
    events = []

    for item in raw:
        try:
            events.append(json.loads(item))
        except Exception:
            pass

    return events

def get_recent_memories():
    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    cur.execute("""
        SELECT agent_name, category, LEFT(content, 600), created_at
        FROM long_term_memory
        WHERE category != 'gmail_summary'
        ORDER BY created_at DESC
        LIMIT 5
    """)

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return rows

print("=" * 60)
print("OPENCLAW DAILY BRIEFING")
print("=" * 60)

print()
print("Generated:", datetime.now())

print()
print("=" * 60)
print("RECENT EVENTS")
print("=" * 60)

events = get_recent_events()

if not events:
    print("No recent events found.")
else:
    for e in events:
        print()
        print(f"[{e.get('agent', 'Unknown')}] {e.get('type', 'unknown')}")
        print(e.get("message", ""))

print()
print("=" * 60)
print("RECENT NON-GMAIL MEMORIES")
print("=" * 60)

memories = get_recent_memories()

if not memories:
    print("No recent non-Gmail memories found.")
else:
    for m in memories:
        print()
        print(f"Agent: {m[0]}")
        print(f"Category: {m[1]}")
        print(f"Content: {m[2]}")
        print(f"Created: {m[3]}")
