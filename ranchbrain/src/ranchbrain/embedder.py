#!/usr/bin/env python3

import json
import subprocess
import urllib.request

OLLAMA_EMBED_URL = "http://192.168.50.233:11434/api/embeddings"
MODEL = "nomic-embed-text:latest"


def run_psql(sql: str) -> str:
    result = subprocess.run(
        [
            "docker", "exec", "-i", "postgres",
            "psql", "-U", "openclaw", "-d", "openclaw",
            "-t", "-A",
        ],
        input=sql,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def embed(text: str):
    payload = json.dumps({"model": MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_EMBED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["embedding"]


def main():
    raw = run_psql("""
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
    SELECT id, content
    FROM ranchbrain_chunks
    WHERE embedding IS NULL
    ORDER BY id
    LIMIT 25
) t;
""")

    rows = json.loads(raw)

    if not rows:
        print("No chunks need embeddings.")
        return

    count = 0

    for row in rows:
        chunk_id = row["id"]
        content = row["content"]

        vector = embed(content)
        vector_sql = "[" + ",".join(str(x) for x in vector) + "]"

        run_psql(f"""
UPDATE ranchbrain_chunks
SET embedding = '{vector_sql}'::vector,
    updated_at = now()
WHERE id = {int(chunk_id)};
""")

        count += 1
        print(f"Embedded chunk {chunk_id}")

    remaining = run_psql("SELECT COUNT(*) FROM ranchbrain_chunks WHERE embedding IS NULL;")

    print()
    print(f"Embedded this run: {count}")
    print(f"Remaining: {remaining}")


if __name__ == "__main__":
    main()
