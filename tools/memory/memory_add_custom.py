import sys
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

agent_name = sys.argv[1]
category = sys.argv[2]
content = sys.argv[3]
source = sys.argv[4]

content_for_embedding = content[:4000]
vector = embed(content_for_embedding)

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

print("Custom memory saved.")
