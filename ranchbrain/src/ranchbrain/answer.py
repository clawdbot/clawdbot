#!/usr/bin/env python3

import json
import sys
import subprocess
import urllib.request

EMBED_URL = "http://192.168.50.233:11434/api/embeddings"
GENERATE_URL = "http://192.168.50.233:11434/api/generate"
EMBED_MODEL = "nomic-embed-text:latest"
ANSWER_MODEL = "hermes3:8b"

def post_json(url, payload, timeout=120):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))

def run_psql(sql: str) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "openclaw", "-d", "openclaw", "-t", "-A"],
        input=sql,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()

def embed(text: str):
    return post_json(EMBED_URL, {"model": EMBED_MODEL, "prompt": text})["embedding"]

def main():
    question = " ".join(sys.argv[1:]).strip()
    if not question:
        print('Usage: answer.py "question"')
        sys.exit(1)

    vector = embed(question)
    vector_sql = "[" + ",".join(str(x) for x in vector) + "]"

    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT source_path, source_type, chunk_index, content
  FROM ranchbrain_chunks
  WHERE embedding IS NOT NULL
  ORDER BY
    CASE
      WHEN source_type = 'note' THEN 0
      ELSE 1
    END,
    embedding <=> '{vector_sql}'::vector
  LIMIT 6
) t;
"""
    rows = json.loads(run_psql(sql))
    context = "\n\n".join(
        f"Source: {r['source_path']} type={r.get('source_type','unknown')} chunk {r['chunk_index']}\n{r['content']}"
        for r in rows
    )

    prompt = f"""You are RanchBrain, a local-first memory assistant for RedBud Ranch and OpenClaw.

Answer the user's question using only the context below. Curated notes with type=note are more authoritative than daily reports. If notes and reports differ, prefer the notes and mention the report discrepancy briefly.

Question:
{question}

Context:
{context}

Answer in 3-6 short sentences. Do not dump raw source text. End with a short "Sources:" list of filenames only.
"""

    result = post_json(GENERATE_URL, {
        "model": ANSWER_MODEL,
        "prompt": prompt,
        "stream": False
    })

    print(result.get("response", "").strip())

if __name__ == "__main__":
    main()
