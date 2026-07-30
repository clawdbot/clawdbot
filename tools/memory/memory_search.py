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

query = input("Search memory for: ")
query_vector = embed(query)

conn = psycopg2.connect(**DB)
cur = conn.cursor()

cur.execute("""
    SELECT agent_name, category, content, source, created_at
    FROM long_term_memory
    ORDER BY embedding <-> %s::vector
    LIMIT 5;
""", (query_vector,))

rows = cur.fetchall()

if not rows:
    print("No memories found.")
else:
    for row in rows:
        print("\n---")
        print("Agent:", row[0])
        print("Category:", row[1])
        print("Content:", row[2])
        print("Source:", row[3])
        print("Created:", row[4])

cur.close()
conn.close()
