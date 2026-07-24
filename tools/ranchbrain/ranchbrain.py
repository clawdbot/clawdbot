#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import sys
from datetime import datetime
from pathlib import Path

import psycopg2
import requests


BASE = Path("/home/gravesab/ai/projects/openclaw")
ENV_FILE = Path(
    "/home/gravesab/.openclaw/credentials/chat-agent.env"
)

KNOWLEDGE_DIR = BASE / "knowledge/ranchbrain"
INBOX_DIR = KNOWLEDGE_DIR / "inbox"
NOTES_DIR = KNOWLEDGE_DIR / "notes"
ARCHIVE_DIR = KNOWLEDGE_DIR / "archive"
REPORT_DIR = BASE / "reports/ranchbrain"


def load_environment() -> None:
    if not ENV_FILE.is_file():
        return

    for raw_line in ENV_FILE.read_text().splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def database_connection():
    return psycopg2.connect(
        host=os.environ.get(
            "OPENCLAW_DB_HOST",
            "127.0.0.1",
        ),
        port=int(
            os.environ.get(
                "OPENCLAW_DB_PORT",
                "5432",
            )
        ),
        dbname=os.environ.get(
            "OPENCLAW_DB_NAME",
            "openclaw",
        ),
        user=os.environ.get(
            "OPENCLAW_DB_USER",
            "openclaw",
        ),
        password=os.environ.get(
            "OPENCLAW_DB_PASSWORD",
            "",
        ),
        connect_timeout=8,
    )


def embedding_url() -> str:
    return os.environ.get(
        "OPENCLAW_OLLAMA_EMBED_URL",
        "http://192.168.50.117:11434/api/embeddings",
    )


def embedding_model() -> str:
    return os.environ.get(
        "OPENCLAW_EMBED_MODEL",
        "nomic-embed-text",
    )


def generation_url() -> str:
    return os.environ.get(
        "OPENCLAW_OLLAMA_GENERATE_URL",
        "http://192.168.50.117:11434/api/generate",
    )


def chat_model() -> str:
    return os.environ.get(
        "OPENCLAW_CHAT_MODEL",
        "llama3.2:3b",
    )


def create_embedding(text: str) -> list[float]:
    response = requests.post(
        embedding_url(),
        json={
            "model": embedding_model(),
            "prompt": text,
        },
        timeout=120,
    )

    response.raise_for_status()

    data = response.json()
    vector = data.get("embedding")

    if not isinstance(vector, list) or not vector:
        raise RuntimeError(
            "Ollama returned no embedding vector."
        )

    if len(vector) != 768:
        raise RuntimeError(
            f"Expected a 768-dimension embedding, "
            f"but Ollama returned {len(vector)} dimensions."
        )

    return [float(value) for value in vector]


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(
        format(value, ".10g")
        for value in vector
    ) + "]"


DUPLICATE_THRESHOLD = 0.90


def find_similar_notes(
    vector: list[float],
    limit: int = 3,
) -> list[tuple]:
    vector_text = vector_literal(vector)

    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            id,
            content,
            source,
            created_at,
            1 - (embedding <=> %s::vector) AS similarity
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category = 'ranchbrain_note'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s;
        """,
        (
            vector_text,
            vector_text,
            limit,
        ),
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return rows


def count_markdown(path: Path) -> int:
    if not path.is_dir():
        return 0

    return sum(
        1
        for item in path.rglob("*.md")
        if item.is_file()
    )


def slugify(text: str, max_length: int = 60) -> str:
    value = text.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    value = value[:max_length].rstrip("-")

    return value or "ranchbrain-note"


def first_line_title(text: str) -> str:
    first_line = text.strip().splitlines()[0]
    first_line = re.sub(r"\s+", " ", first_line)

    if len(first_line) > 80:
        first_line = first_line[:77].rstrip() + "..."

    return first_line


def add_note(
    note_text: str,
    force: bool = False,
) -> str:
    note_text = note_text.strip()

    if not note_text:
        return (
            "🧠 RanchBrain\n\n"
            "No note was provided.\n\n"
            "Usage:\n"
            "brain add <note>"
        )

    # Create the embedding before writing anything so a blocked duplicate
    # leaves no orphaned Markdown file or database record.
    vector = create_embedding(note_text)

    if not force:
        similar_notes = find_similar_notes(vector)

        duplicates = [
            row
            for row in similar_notes
            if float(row[4] or 0.0) >= DUPLICATE_THRESHOLD
        ]

        if duplicates:
            lines = [
                "🧠 RanchBrain Duplicate Detected",
                "",
                "This note was not saved because it closely matches "
                "existing knowledge.",
                "",
            ]

            for number, row in enumerate(duplicates, start=1):
                memory_id, content, source, created_at, similarity = row

                preview = re.sub(
                    r"\s+",
                    " ",
                    str(content),
                ).strip()

                if len(preview) > 300:
                    preview = preview[:297].rstrip() + "..."

                lines.extend(
                    [
                        f"{number}. Match: {float(similarity):.1%}",
                        f"Memory ID: {memory_id}",
                        f"Existing note: {preview}",
                        f"Created: {created_at}",
                        f"File: {source}",
                        "",
                    ]
                )

            lines.extend(
                [
                    "No new Markdown file or memory record was created.",
                    "",
                    "To deliberately save another copy, use:",
                    "• brain add force <note>",
                    "• /brainaddforce <note>",
                ]
            )

            return "\n".join(lines).rstrip()

    NOTES_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    now = datetime.now()
    title = first_line_title(note_text)
    slug = slugify(title)

    filename = (
        f"{now.strftime('%Y%m%d-%H%M%S')}-"
        f"{slug}.md"
    )

    path = INBOX_DIR / filename

    markdown = (
        "---\n"
        f"title: \"{title.replace('"', chr(39))}\"\n"
        f"created: {now.isoformat(timespec='seconds')}\n"
        "source: RanchBrain\n"
        "status: pending\n"
        "---\n\n"
        f"# {title}\n\n"
        f"{note_text}\n"
    )

    path.write_text(markdown)

    try:
        conn = database_connection()
        cur = conn.cursor()

        cur.execute(
            """
            INSERT INTO long_term_memory
            (
                agent_name,
                category,
                content,
                source,
                embedding
            )
            VALUES
            (
                %s,
                %s,
                %s,
                %s,
                %s::vector
            )
            RETURNING id;
            """,
            (
                "RanchBrain",
                "ranchbrain_pending",
                note_text,
                str(path),
                vector_literal(vector),
            ),
        )

        memory_id = int(cur.fetchone()[0])

        conn.commit()
        cur.close()
        conn.close()

    except Exception:
        path.unlink(missing_ok=True)
        raise

    return (
        "🧠 RanchBrain Note Submitted for Approval\n\n"
        f"Title: {title}\n"
        f"Memory ID: {memory_id}\n"
        f"Markdown: {path}\n"
        f"Embedding: {len(vector)} dimensions"
    )


def search_notes(query: str, limit: int = 5) -> str:
    query = query.strip()

    if not query:
        return (
            "🧠 RanchBrain\n\n"
            "No search question was provided.\n\n"
            "Usage:\n"
            "brain search <question>"
        )

    vector = create_embedding(query)
    vector_text = vector_literal(vector)

    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            id,
            content,
            source,
            created_at,
            1 - (embedding <=> %s::vector) AS similarity
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category = 'ranchbrain_note'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s;
        """,
        (
            vector_text,
            vector_text,
            limit,
        ),
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    if not rows:
        return (
            "🧠 RanchBrain Search\n\n"
            "No RanchBrain notes have been indexed yet."
        )

    lines = [
        "🧠 RanchBrain Search",
        "",
        f"Question: {query}",
        "",
    ]

    for number, row in enumerate(rows, start=1):
        memory_id, content, source, created_at, similarity = row

        preview = re.sub(
            r"\s+",
            " ",
            str(content),
        ).strip()

        if len(preview) > 350:
            preview = preview[:347].rstrip() + "..."

        score = float(similarity or 0.0)

        lines.extend(
            [
                f"{number}. Match: {score:.1%}",
                f"Memory ID: {memory_id}",
                f"Note: {preview}",
                f"Source: {source}",
                f"Created: {created_at}",
                "",
            ]
        )

    return "\n".join(lines).rstrip()


def answer_from_notes(question: str, limit: int = 5) -> str:
    question = question.strip()

    if not question:
        return (
            "🧠 RanchBrain\n\n"
            "No question was provided.\n\n"
            "Usage:\n"
            "brain ask <question>"
        )

    query_vector = create_embedding(question)
    query_vector_text = vector_literal(query_vector)

    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            id,
            content,
            source,
            created_at,
            1 - (embedding <=> %s::vector) AS similarity
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category = 'ranchbrain_note'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s;
        """,
        (
            query_vector_text,
            query_vector_text,
            limit,
        ),
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    if not rows:
        return (
            "🧠 RanchBrain Answer\n\n"
            "I do not have any indexed RanchBrain notes "
            "that can answer that question."
        )

    evidence_sections = []
    source_lines = []

    for number, row in enumerate(rows, start=1):
        memory_id, content, source, created_at, similarity = row
        score = float(similarity or 0.0)

        evidence_sections.append(
            f"[Source {number}]\n"
            f"Memory ID: {memory_id}\n"
            f"Similarity: {score:.1%}\n"
            f"Created: {created_at}\n"
            f"File: {source}\n"
            f"Content:\n{content}"
        )

        source_lines.append(
            f"• Source {number}: Memory ID {memory_id} "
            f"({score:.1%})\n"
            f"  {source}"
        )

    evidence = "\n\n".join(evidence_sections)

    prompt = f"""
You are RanchBrain, Andy's private local knowledge assistant.

Answer the question using ONLY the supplied RanchBrain sources.

Rules:
- Do not use outside knowledge.
- Do not guess or invent details.
- If the sources do not contain the answer, say exactly:
  "I do not have enough information in RanchBrain to answer that."
- Keep the answer concise.
- Cite supporting source numbers in square brackets, such as [Source 1].
- Do not claim to have searched the internet.

Question:
{question}

RanchBrain sources:
{evidence}
"""

    response = requests.post(
        generation_url(),
        json={
            "model": chat_model(),
            "prompt": prompt,
            "stream": False,
        },
        timeout=180,
    )

    response.raise_for_status()

    answer = str(
        response.json().get("response", "")
    ).strip()

    if not answer:
        raise RuntimeError(
            "The local AI returned an empty RanchBrain answer."
        )

    return (
        "🧠 RanchBrain Answer\n\n"
        f"{answer}\n\n"
        "Sources\n"
        + "\n".join(source_lines)
    )


def list_notes(limit: int = 10) -> str:
    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            id,
            content,
            source,
            created_at
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category = 'ranchbrain_note'
        ORDER BY created_at DESC
        LIMIT %s;
        """,
        (limit,),
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    if not rows:
        return (
            "🧠 RanchBrain Notes\n\n"
            "No RanchBrain notes have been added yet."
        )

    lines = [
        "🧠 RanchBrain Notes",
        "",
    ]

    for memory_id, content, source, created_at in rows:
        title = first_line_title(str(content))

        lines.extend(
            [
                f"• ID {memory_id}: {title}",
                f"  Created: {created_at}",
                f"  File: {source}",
            ]
        )

    return "\n".join(lines)


def database_status() -> dict[str, object]:
    result: dict[str, object] = {
        "online": False,
        "database": "unknown",
        "memory_count": 0,
        "ranchbrain_count": 0,
        "vector_extension": False,
        "error": "",
    }

    try:
        conn = database_connection()
        cur = conn.cursor()

        cur.execute(
            "SELECT current_database();"
        )
        database = cur.fetchone()[0]

        cur.execute(
            "SELECT COUNT(*) FROM long_term_memory;"
        )
        memory_count = int(cur.fetchone()[0])

        cur.execute(
            """
            SELECT COUNT(*)
            FROM long_term_memory
            WHERE agent_name = 'RanchBrain';
            """
        )
        ranchbrain_count = int(cur.fetchone()[0])

        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM pg_extension
                WHERE extname = 'vector'
            );
            """
        )
        vector_extension = bool(cur.fetchone()[0])

        result.update(
            {
                "online": True,
                "database": database,
                "memory_count": memory_count,
                "ranchbrain_count": ranchbrain_count,
                "vector_extension": vector_extension,
            }
        )

        cur.close()
        conn.close()

    except Exception as exc:
        result["error"] = (
            f"{type(exc).__name__}: {exc}"
        )

    return result


def ollama_status() -> dict[str, object]:
    tags_url = embedding_url().replace(
        "/api/embeddings",
        "/api/tags",
    )

    result: dict[str, object] = {
        "online": False,
        "models": [],
        "error": "",
    }

    try:
        response = requests.get(
            tags_url,
            timeout=8,
        )
        response.raise_for_status()

        result["online"] = True
        result["models"] = sorted(
            str(item.get("name", "unknown"))
            for item in response.json().get(
                "models",
                [],
            )
        )

    except Exception as exc:
        result["error"] = (
            f"{type(exc).__name__}: {exc}"
        )

    return result


def build_status() -> str:
    database = database_status()
    ollama = ollama_status()

    problems: list[str] = []

    if not database["online"]:
        problems.append("PostgreSQL unavailable")

    if not database["vector_extension"]:
        problems.append("pgvector extension unavailable")

    if not ollama["online"]:
        problems.append("M4 Ollama unavailable")

    overall = "READY" if not problems else "WATCH"

    lines = [
        "🧠 RanchBrain Status",
        "",
        f"Overall: {overall}",
        "",
        "Knowledge Library",
        f"• Inbox Markdown files: {count_markdown(INBOX_DIR)}",
        f"• Approved notes: {count_markdown(NOTES_DIR)}",
        f"• Archived notes: {count_markdown(ARCHIVE_DIR)}",
        "",
        "Memory Database",
    ]

    if database["online"]:
        lines.extend(
            [
                "• PostgreSQL: online",
                f"• Database: {database['database']}",
                f"• Long-term memories: {database['memory_count']}",
                f"• RanchBrain memories: {database['ranchbrain_count']}",
                f"• pgvector: "
                f"{'available' if database['vector_extension'] else 'missing'}",
            ]
        )
    else:
        lines.extend(
            [
                "• PostgreSQL: unavailable",
                f"• Error: {database['error']}",
            ]
        )

    lines.extend(
        [
            "",
            "Local AI",
            (
                "• M4 Ollama: online"
                if ollama["online"]
                else "• M4 Ollama: unavailable"
            ),
            f"• Embedding model: {embedding_model()}",
            "",
            "Knowledge Commands",
            "• brain add <note>",
            "• brain search <question>",
            "• brain list",
            "• brain status",
        ]
    )

    return "\n".join(lines)


def status_report() -> str:
    report = build_status()

    REPORT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    path = REPORT_DIR / (
        "ranchbrain-status-"
        + datetime.now().strftime("%Y%m%d-%H%M%S")
        + ".txt"
    )

    path.write_text(report + "\n")

    return report + f"\n\nSaved report: {path}"


def help_message() -> str:
    return (
        "🧠 RanchBrain Commands\n\n"
        "• brain add <note>\n"
        "• brain search <question>\n"
        "• brain ask <question>\n"
        "• brain list\n"
        "• brain status\n\n"
        "Telegram shortcuts:\n"
        "• /brainadd <note>\n"
        "• /brainsearch <question>\n"
        "• /brainask <question>\n"
        "• /brainlist\n"
        "• /brainstatus"
    )


def main() -> int:
    load_environment()

    raw = " ".join(sys.argv[1:]).strip()
    lowered = raw.lower()

    try:
        if lowered in {
            "",
            "status",
            "brain status",
            "ranchbrain status",
        }:
            print(status_report())
            return 0

        if lowered in {
            "help",
            "brain help",
            "ranchbrain help",
        }:
            print(help_message())
            return 0

        if lowered == "list" or lowered == "brain list":
            print(list_notes())
            return 0

        if lowered.startswith("add force "):
            print(
                add_note(
                    raw[len("add force "):],
                    force=True,
                )
            )
            return 0

        if lowered.startswith("brain add force "):
            print(
                add_note(
                    raw[len("brain add force "):],
                    force=True,
                )
            )
            return 0

        if lowered.startswith("add "):
            print(add_note(raw[4:]))
            return 0

        if lowered.startswith("brain add "):
            print(add_note(raw[len("brain add "):]))
            return 0

        if lowered.startswith("search "):
            print(search_notes(raw[7:]))
            return 0

        if lowered.startswith("brain search "):
            print(
                search_notes(
                    raw[len("brain search "):]
                )
            )
            return 0

        if lowered.startswith("ask "):
            print(answer_from_notes(raw[4:]))
            return 0

        if lowered.startswith("brain ask "):
            print(
                answer_from_notes(
                    raw[len("brain ask "):]
                )
            )
            return 0

        print(
            "🧠 RanchBrain\n\n"
            "Unknown RanchBrain command.\n\n"
            + help_message()
        )
        return 0

    except Exception as exc:
        print(
            "⚠️ RanchBrain command failed\n\n"
            f"{type(exc).__name__}: {exc}"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
