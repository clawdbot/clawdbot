import os
import requests
import psycopg2

OLLAMA_URL = os.environ.get(
    "OPENCLAW_OLLAMA_EMBEDDINGS_URL",
    f"{os.environ.get('OPENCLAW_OLLAMA_BASE_URL', 'http://192.168.50.117:11434').rstrip('/')}/api/embeddings",
)
MODEL = os.environ.get("OPENCLAW_MEMORY_EMBEDDING_MODEL", "nomic-embed-text")

DB = {
    "host": os.environ.get("OPENCLAW_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("OPENCLAW_DB_PORT", "5432")),
    "dbname": os.environ.get("OPENCLAW_DB_NAME", "openclaw"),
    "user": os.environ.get("OPENCLAW_DB_USER", "openclaw"),
}
if os.environ.get("OPENCLAW_DB_PASSWORD"):
    DB["password"] = os.environ["OPENCLAW_DB_PASSWORD"]

def embed(text):
    r = requests.post(OLLAMA_URL, json={
        "model": MODEL,
        "prompt": text
    })
    r.raise_for_status()
    return r.json()["embedding"]

def save_memory(agent_name, category, content, source="manual"):
    vector = embed(content)

    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO long_term_memory
        (agent_name, category, content, source, embedding)
        VALUES (%s, %s, %s, %s, %s)
    """, (agent_name, category, content, source, vector))

    conn.commit()
    cur.close()
    conn.close()

    print("Memory saved successfully.")

if __name__ == "__main__":
    save_memory(
        "HomeManager",
        "home_assistant",
        "Home Assistant runs on the Intel mini in Docker. Scrypted also runs on the Intel mini. Bluetooth was fixed by running Home Assistant with host networking, privileged mode, NET_ADMIN, NET_RAW, AppArmor unconfined, and D-Bus mounted from /run/dbus. Home Assistant is now stable and Bluetooth errors are resolved.",
        "setup"
    )
