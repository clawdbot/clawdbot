import json
import os
import sys
import redis
import requests
import subprocess
import psycopg2

from datetime import datetime
from pathlib import Path

ENV_FILE = Path("/home/gravesab/.openclaw/credentials/chat-agent.env")


def load_environment() -> None:
    if not ENV_FILE.is_file():
        return

    for raw_line in ENV_FILE.read_text().splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_environment()

OLLAMA_URL = os.environ.get(
    "OPENCLAW_OLLAMA_GENERATE_URL",
    "http://192.168.50.117:11434/api/generate",
)

EMBED_URL = os.environ.get(
    "OPENCLAW_OLLAMA_EMBED_URL",
    "http://192.168.50.117:11434/api/embeddings",
)

MODEL = os.environ.get(
    "OPENCLAW_CHAT_MODEL",
    "llama3.2:3b",
)

EMBED_MODEL = os.environ.get(
    "OPENCLAW_EMBED_MODEL",
    "nomic-embed-text",
)

DB = {
    "host": os.environ.get("OPENCLAW_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("OPENCLAW_DB_PORT", "5432")),
    "dbname": os.environ.get("OPENCLAW_DB_NAME", "openclaw"),
    "user": os.environ.get("OPENCLAW_DB_USER", "openclaw"),
    "password": os.environ.get("OPENCLAW_DB_PASSWORD", ""),
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

def embed(text):

    response = requests.post(
        EMBED_URL,
        json={
            "model": EMBED_MODEL,
            "prompt": text
        },
        timeout=120
    )

    response.raise_for_status()

    return response.json()["embedding"]

def save_memory(question, answer):

    combined = f"""
USER QUESTION:
{question}

CHAT RESPONSE:
{answer}
"""

    vector = embed(combined)

    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO long_term_memory
        (
            agent_name,
            category,
            content,
            source,
            embedding
        )
        VALUES (%s, %s, %s, %s, %s)
    """, (
        "ChatAgent",
        "chat_memory",
        combined,
        "chat_session",
        vector
    ))

    conn.commit()

    cur.close()
    conn.close()

def recent_events(limit=10):

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
        SELECT agent_name, category, LEFT(content, 500)
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

def safe_context(name, function):
    try:
        value = function()
        return value or f"{name}: no data available"
    except Exception as exc:
        return (
            f"{name}: temporarily unavailable "
            f"({type(exc).__name__})"
        )


def ask_llm(question):

    infrastructure = safe_context(
        "Infrastructure status",
        infrastructure_status,
    )

    events = safe_context(
        "Recent events",
        recent_events,
    )

    memories = safe_context(
        "Recent memories",
        recent_memories,
    )

    context = f"""
You are OpenClaw Ranch Bot, Andy's helpful local AI assistant.

You can answer ordinary questions about nature, property care, technology,
home automation, OpenClaw, and general knowledge.

Use the operational context below only when it is relevant to the user's
question. Ignore unavailable or unrelated context.

Current Infrastructure:
{infrastructure}

Recent Events:
{events}

Recent Memories:
{memories}

User Question:
{question}

Answer the user's actual question directly, clearly, and concisely.
Do not refuse an ordinary harmless question merely because it is unrelated
to OpenClaw operations.
Do not invent system status, events, or memories.
"""

    response = requests.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "prompt": context,
            "stream": False
        },
        timeout=180
    )

    response.raise_for_status()

    return response.json()["response"]

def publish(answer):

    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": "ChatAgent",
        "type": "chat_response",
        "message": answer,
    }

    r.lpush(
        "openclaw:events",
        json.dumps(event)
    )

def main() -> int:
    question = " ".join(sys.argv[1:]).strip()

    if not question:
        question = input("Ask OpenClaw: ").strip()

    if not question:
        print("Please provide a question.")
        return 1

    try:
        answer = ask_llm(question).strip()
    except Exception as exc:
        print(
            "⚠️ OpenClaw AI is temporarily unavailable.\n\n"
            f"{type(exc).__name__}: {exc}"
        )
        return 1

    # Memory and event publishing should never prevent the answer
    # from reaching the user.
    try:
        save_memory(question, answer)
    except Exception as exc:
        print(
            f"ChatAgent memory warning: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )

    try:
        publish(answer)
    except Exception as exc:
        print(
            f"ChatAgent event warning: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )

    print(answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
