#!/usr/bin/env python3

import json
import sys
import subprocess
import urllib.request

OLLAMA_EMBED_URL = "http://192.168.50.233:11434/api/embeddings"
MODEL = "nomic-embed-text:latest"

def embed(text: str):
    payload = json.dumps({"model": MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_EMBED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))["embedding"]

def run_psql(sql: str) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "openclaw", "-d", "openclaw", "-t", "-A"],
        input=sql,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()

def main():
    query = " ".join(sys.argv[1:]).strip()
    if not query:
        print('Usage: semantic_search.py "question"')
        sys.exit(1)

    vector = embed(query)
    vector_sql = "[" + ",".join(str(x) for x in vector) + "]"

    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT
    source_path,
    chunk_index,
    ROUND((1 - (embedding <=> '{vector_sql}'::vector))::numeric, 4) AS similarity,
    LEFT(REPLACE(content, E'\\n', ' '), 600) AS preview
  FROM ranchbrain_chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> '{vector_sql}'::vector
  LIMIT 8
) t;
"""
    rows = json.loads(run_psql(sql))

    for i, row in enumerate(rows, start=1):
        print(f"\nResult {i}")
        print(f"Source: {row['source_path']}")
        print(f"Chunk: {row['chunk_index']}")
        print(f"Similarity: {row['similarity']}")
        print("Preview:")
        print(row["preview"])

if __name__ == "__main__":
    main()
