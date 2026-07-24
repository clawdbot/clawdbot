import json
import redis
import requests
import psycopg2
import subprocess

from datetime import datetime

OLLAMA_URL = "http://192.168.50.233:11434/api/generate"

MODEL = "llama3.2:3b"

DB = {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "openclaw",
    "user": "openclaw",
    "password": "Krgabg99$",
}

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    decode_responses=True
)

def cmd(command):
    try:
        return subprocess.check_output(
            command,
            shell=True,
            text=True
        ).strip()
    except Exception as e:
        return str(e)

def recent_events(limit=15):

    raw = r.lrange(
        "openclaw:events",
        0,
        limit
    )

    events = []

    for item in raw:

        try:
            event = json.loads(item)

            events.append(
                f"[{event['agent']}] "
                f"{event['type']} - "
                f"{event['message']}"
            )

        except:
            pass

    return "\n".join(events)

def recent_memories(limit=5):

    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    cur.execute("""
        SELECT agent_name, category, LEFT(content, 400)
        FROM long_term_memory
        WHERE category != 'gmail_summary'
        ORDER BY created_at DESC
        LIMIT %s
    """, (limit,))

    rows = cur.fetchall()

    cur.close()
    conn.close()

    output = []

    for row in rows:
        output.append(
            f"[{row[0]}:{row[1]}] {row[2]}"
        )

    return "\n".join(output)

def infrastructure_status():

    return cmd(
        "docker ps --format '{{.Names}} - {{.Status}}'"
    )

def generate_summary():

    prompt = f"""
You are OpenClaw AI Operations Summary Agent.

Current Infrastructure:
{infrastructure_status()}

Recent Events:
{recent_events()}

Recent Memories:
{recent_memories()}

Generate a concise operational summary:
- infrastructure health
- recent incidents
- remediation actions
- any concerns
- recommended attention items
"""

    response = requests.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "prompt": prompt,
            "stream": False
        },
        timeout=180
    )

    response.raise_for_status()

    return response.json()["response"]

def publish(summary):

    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": "AISummaryAgent",
        "type": "ai_operational_summary",
        "message": summary,
    }

    r.lpush(
        "openclaw:events",
        json.dumps(event)
    )

    print()
    print("=" * 60)
    print("AI OPERATIONAL SUMMARY")
    print("=" * 60)
    print()
    print(summary)

if __name__ == "__main__":

    summary = generate_summary()

    publish(summary)
