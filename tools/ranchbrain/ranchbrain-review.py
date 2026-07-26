#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import shutil
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

DUPLICATE_THRESHOLD = 0.90


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

    vector = response.json().get("embedding")

    if not isinstance(vector, list) or not vector:
        raise RuntimeError(
            "Ollama returned no embedding vector."
        )

    if len(vector) != 768:
        raise RuntimeError(
            f"Expected 768 dimensions, received {len(vector)}."
        )

    return [float(value) for value in vector]


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(
        format(value, ".10g")
        for value in vector
    ) + "]"


def slugify(text: str, max_length: int = 60) -> str:
    value = text.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    value = value[:max_length].rstrip("-")

    return value or "ranchbrain-note"


def title_from_text(text: str) -> str:
    title = re.sub(
        r"\s+",
        " ",
        text.strip().splitlines()[0],
    )

    if len(title) > 80:
        title = title[:77].rstrip() + "..."

    return title


def rewrite_status(
    path: Path,
    new_status: str,
) -> None:
    if not path.is_file():
        return

    text = path.read_text()

    updated, count = re.subn(
        r"(?m)^status:\s*.*$",
        f"status: {new_status}",
        text,
        count=1,
    )

    if count == 0:
        updated = text.replace(
            "---\n\n",
            f"status: {new_status}\n---\n\n",
            1,
        )

    path.write_text(updated)


def find_duplicates(
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
            category,
            content,
            source,
            created_at,
            1 - (embedding <=> %s::vector) AS similarity
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category IN (
              'ranchbrain_note',
              'ranchbrain_pending'
          )
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

    return [
        row
        for row in rows
        if float(row[5] or 0.0) >= DUPLICATE_THRESHOLD
    ]


def capture_note(
    note_text: str,
    force: bool = False,
) -> str:
    note_text = note_text.strip()

    if not note_text:
        return (
            "🧠 RanchBrain Capture\n\n"
            "No note was provided.\n\n"
            "Usage: /brainadd <note>"
        )

    vector = create_embedding(note_text)

    if not force:
        duplicates = find_duplicates(vector)

        if duplicates:
            lines = [
                "🧠 RanchBrain Duplicate Detected",
                "",
                "The pending note was not created because it closely "
                "matches existing knowledge.",
                "",
            ]

            for number, row in enumerate(
                duplicates,
                start=1,
            ):
                (
                    memory_id,
                    category,
                    content,
                    source,
                    created_at,
                    similarity,
                ) = row

                preview = re.sub(
                    r"\s+",
                    " ",
                    str(content),
                ).strip()

                if len(preview) > 280:
                    preview = preview[:277].rstrip() + "..."

                lines.extend(
                    [
                        f"{number}. Match: {float(similarity):.1%}",
                        f"Memory ID: {memory_id}",
                        f"Status: {category}",
                        f"Existing note: {preview}",
                        f"Created: {created_at}",
                        f"File: {source}",
                        "",
                    ]
                )

            lines.extend(
                [
                    "No pending Markdown file or database record "
                    "was created.",
                    "",
                    "To capture it deliberately:",
                    "/brainaddforce <note>",
                ]
            )

            return "\n".join(lines).rstrip()

    INBOX_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    now = datetime.now()
    title = title_from_text(note_text)
    safe_title = title.replace('"', "'")

    filename = (
        f"{now.strftime('%Y%m%d-%H%M%S')}-"
        f"{slugify(title)}.md"
    )

    path = INBOX_DIR / filename

    markdown = (
        "---\n"
        f'title: "{safe_title}"\n'
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
                'RanchBrain',
                'ranchbrain_pending',
                %s,
                %s,
                %s::vector
            )
            RETURNING id;
            """,
            (
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
        "🧠 RanchBrain Note Captured\n\n"
        f"Pending Memory ID: {memory_id}\n"
        f"Title: {title}\n"
        f"File: {path}\n"
        "Status: Pending review\n\n"
        f"Approve: /brainapprove {memory_id}\n"
        f"Reject: /brainreject {memory_id}"
    )


def review_pending(limit: int = 10) -> str:
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
          AND category = 'ranchbrain_pending'
        ORDER BY created_at ASC
        LIMIT %s;
        """,
        (limit,),
    )

    rows = cur.fetchall()

    cur.close()
    conn.close()

    if not rows:
        return (
            "🧠 RanchBrain Review Queue\n\n"
            "No notes are waiting for approval."
        )

    lines = [
        "🧠 RanchBrain Review Queue",
        "",
    ]

    for memory_id, content, source, created_at in rows:
        preview = re.sub(
            r"\s+",
            " ",
            str(content),
        ).strip()

        if len(preview) > 320:
            preview = preview[:317].rstrip() + "..."

        lines.extend(
            [
                f"Memory ID: {memory_id}",
                f"Captured: {created_at}",
                f"Note: {preview}",
                f"File: {source}",
                f"Approve: /brainapprove {memory_id}",
                f"Reject: /brainreject {memory_id}",
                "",
            ]
        )

    return "\n".join(lines).rstrip()


def approve_note(memory_id: int) -> str:
    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT content, source
        FROM long_term_memory
        WHERE id = %s
          AND agent_name = 'RanchBrain'
          AND category = 'ranchbrain_pending'
        FOR UPDATE;
        """,
        (memory_id,),
    )

    row = cur.fetchone()

    if not row:
        cur.close()
        conn.close()

        return (
            "🧠 RanchBrain Approval\n\n"
            f"Pending Memory ID {memory_id} was not found."
        )

    content, source = row
    old_path = Path(str(source))

    NOTES_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    new_path = NOTES_DIR / old_path.name

    if old_path.is_file():
        shutil.move(str(old_path), str(new_path))
        rewrite_status(new_path, "approved")
    else:
        raise FileNotFoundError(
            f"Pending Markdown file not found: {old_path}"
        )

    try:
        cur.execute(
            """
            UPDATE long_term_memory
            SET
                category = 'ranchbrain_note',
                source = %s
            WHERE id = %s;
            """,
            (
                str(new_path),
                memory_id,
            ),
        )

        conn.commit()

    except Exception:
        if new_path.is_file():
            shutil.move(str(new_path), str(old_path))
            rewrite_status(old_path, "pending")

        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()

    return (
        "🧠 RanchBrain Note Approved\n\n"
        f"Memory ID: {memory_id}\n"
        f"Note: {content}\n"
        f"Approved file: {new_path}\n\n"
        "This note is now trusted knowledge and can be used by "
        "/brainsearch and /brainask."
    )


def reject_note(memory_id: int) -> str:
    conn = database_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT content, source, category
        FROM long_term_memory
        WHERE id = %s
          AND agent_name = 'RanchBrain'
          AND category IN ('ranchbrain_pending', 'ranchbrain_note')
        FOR UPDATE;
        """,
        (memory_id,),
    )

    row = cur.fetchone()

    if not row:
        cur.close()
        conn.close()

        return (
            "🧠 RanchBrain Rejection\n\n"
            f"Reviewable Memory ID {memory_id} was not found."
        )

    content, source, prior_category = row
    old_path = Path(str(source))
    prior_status = (
        "approved"
        if prior_category == "ranchbrain_note"
        else "pending"
    )

    ARCHIVE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    new_path = ARCHIVE_DIR / old_path.name

    if old_path.is_file():
        shutil.move(str(old_path), str(new_path))
        rewrite_status(new_path, "rejected")
    else:
        raise FileNotFoundError(
            f"Pending Markdown file not found: {old_path}"
        )

    try:
        cur.execute(
            """
            UPDATE long_term_memory
            SET
                category = 'ranchbrain_rejected',
                source = %s
            WHERE id = %s;
            """,
            (
                str(new_path),
                memory_id,
            ),
        )

        conn.commit()

    except Exception:
        if new_path.is_file():
            shutil.move(str(new_path), str(old_path))
            rewrite_status(old_path, prior_status)

        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()

    return (
        "🧠 RanchBrain Note Rejected\n\n"
        f"Memory ID: {memory_id}\n"
        f"Note: {content}\n"
        f"Archived file: {new_path}\n\n"
        "The note will not be used as trusted RanchBrain knowledge."
    )


def parse_memory_id(value: str) -> int:
    value = value.strip()

    if not value.isdigit():
        raise ValueError(
            "A numeric RanchBrain memory ID is required."
        )

    return int(value)


def help_message() -> str:
    return (
        "🧠 RanchBrain Review Commands\n\n"
        "• /brainadd <note>\n"
        "• /brainaddforce <note>\n"
        "• /brainreview\n"
        "• /brainapprove <memory-id>\n"
        "• /brainreject <memory-id>"
    )


def main() -> int:
    load_environment()

    raw = " ".join(sys.argv[1:]).strip()
    lowered = raw.lower()

    try:
        if lowered.startswith("capture force "):
            print(
                capture_note(
                    raw[len("capture force "):],
                    force=True,
                )
            )
            return 0

        if lowered.startswith("capture "):
            print(capture_note(raw[len("capture "):]))
            return 0

        if lowered in {
            "review",
            "review pending",
            "list pending",
        }:
            print(review_pending())
            return 0

        if lowered.startswith("approve "):
            memory_id = parse_memory_id(
                raw[len("approve "):]
            )
            print(approve_note(memory_id))
            return 0

        if lowered.startswith("reject "):
            memory_id = parse_memory_id(
                raw[len("reject "):]
            )
            print(reject_note(memory_id))
            return 0

        if lowered in {
            "",
            "help",
        }:
            print(help_message())
            return 0

        print(
            "🧠 RanchBrain Review\n\n"
            "Unknown review command.\n\n"
            + help_message()
        )
        return 0

    except Exception as exc:
        print(
            "⚠️ RanchBrain review command failed\n\n"
            f"{type(exc).__name__}: {exc}"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
