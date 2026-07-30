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
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "prompt": text
        },
        timeout=60
    )
    response.raise_for_status()
    return response.json()["embedding"]

def detect_filter(query):
    q = query.lower()

    if any(word in q for word in ["home", "assistant", "scrypted", "bluetooth", "camera", "ha"]):
        return "home"

    if any(word in q for word in ["gmail", "email", "mail", "inbox"]):
        return "gmail"

    if any(word in q for word in ["openclaw", "ollama", "infrastructure", "intel", "m4"]):
        return "infrastructure"

    return "all"

def search_memory(query, limit=5):
    vector = embed(query)
    search_type = detect_filter(query)

    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    if search_type == "home":
        cur.execute("""
            SELECT agent_name, category, content, created_at, embedding <=> %s::vector AS distance
            FROM long_term_memory
            WHERE agent_name = 'HomeManager'
               OR category ILIKE '%%home%%'
               OR category ILIKE '%%assistant%%'
               OR content ILIKE '%%Home Assistant%%'
               OR content ILIKE '%%Scrypted%%'
               OR content ILIKE '%%Bluetooth%%'
            ORDER BY distance ASC
            LIMIT %s
        """, (str(vector), limit))

    elif search_type == "gmail":
        cur.execute("""
            SELECT agent_name, category, content, created_at, embedding <=> %s::vector AS distance
            FROM long_term_memory
            WHERE agent_name = 'MailManager'
               OR category ILIKE '%%gmail%%'
               OR category ILIKE '%%mail%%'
            ORDER BY distance ASC
            LIMIT %s
        """, (str(vector), limit))

    elif search_type == "infrastructure":
        cur.execute("""
            SELECT agent_name, category, content, created_at, embedding <=> %s::vector AS distance
            FROM long_term_memory
            WHERE category ILIKE '%%infrastructure%%'
               OR content ILIKE '%%OpenClaw%%'
               OR content ILIKE '%%Ollama%%'
               OR content ILIKE '%%Intel mini%%'
               OR content ILIKE '%%M4 Mac%%'
            ORDER BY distance ASC
            LIMIT %s
        """, (str(vector), limit))

    else:
        cur.execute("""
            SELECT agent_name, category, content, created_at, embedding <=> %s::vector AS distance
            FROM long_term_memory
            WHERE category != 'gmail_summary'
            ORDER BY distance ASC
            LIMIT %s
        """, (str(vector), limit))

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return rows, search_type

query = input("Memory search query: ")

results, search_type = search_memory(query)

print()
print("=" * 60)
print("MEMORY CONTEXT RESULTS")
print("=" * 60)
print(f"Search type: {search_type}")

if not results:
    print("No matching memories found.")
else:
    for r in results:
        print()
        print(f"Agent: {r[0]}")
        print(f"Category: {r[1]}")
        print(f"Distance: {round(r[4], 4)}")
        print(f"Created: {r[3]}")
        print()
        print(r[2][:800])
