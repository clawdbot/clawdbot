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
