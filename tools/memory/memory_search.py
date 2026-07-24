import requests
import psycopg2

OLLAMA_URL = "http://192.168.50.233:11434/api/embeddings"
MODEL = "nomic-embed-text"

DB = {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "openclaw",
    "user": "openclaw",
    "password": "Krgabg99$",
}

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
