import json
import os
import redis
import requests
import subprocess

from datetime import datetime

OLLAMA_URL = os.environ.get(
    "OPENCLAW_OLLAMA_GENERATE_URL",
    "http://192.168.50.117:11434/api/generate",
)

MODEL = "llama3.2:3b"

DB_CONTAINER = os.environ.get("OPENCLAW_DB_CONTAINER", "postgres")
DB_NAME = os.environ.get("OPENCLAW_DB_NAME", "openclaw")
DB_USER = os.environ.get("OPENCLAW_DB_USER", "openclaw")

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
    safe_limit = max(1, min(int(limit), 50))
    query = f"""
        SELECT json_build_object(
            'agent_name', agent_name,
            'category', category,
            'content', LEFT(content, 400)
        )::text
        FROM long_term_memory
        WHERE category != 'gmail_summary'
        ORDER BY created_at DESC
        LIMIT {safe_limit}
    """
    result = subprocess.run(
        [
            "docker", "exec", DB_CONTAINER,
            "psql", "-U", DB_USER, "-d", DB_NAME,
            "-v", "ON_ERROR_STOP=1", "-At", "-c", query,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )

    output = []
    for line in result.stdout.splitlines():
        row = json.loads(line)
        output.append(
            f"[{row['agent_name']}:{row['category']}] {row['content']}"
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
