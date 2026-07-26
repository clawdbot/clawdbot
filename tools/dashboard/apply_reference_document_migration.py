#!/usr/bin/env python3
"""Apply the reference-document registry migration to development only."""

from pathlib import Path
import sys

OPENCLAW_ROOT = Path(__file__).resolve().parents[2]
if str(OPENCLAW_ROOT) not in sys.path:
    sys.path.insert(0, str(OPENCLAW_ROOT))
from tools.dashboard.app import ranchbrain_db


MIGRATION = (
    Path(__file__).resolve().parent
    / "migrations"
    / "001_create_reference_documents.sql"
)


def main():
    connection = ranchbrain_db()
    cursor = connection.cursor()
    try:
        cursor.execute("SELECT current_database();")
        database_name = str(cursor.fetchone()[0])
        if not database_name.endswith("_dev"):
            raise RuntimeError(
                "Refusing migration because the selected database is not "
                f"a development database: {database_name}"
            )
        cursor.execute(MIGRATION.read_text(encoding="utf-8"))
        connection.commit()
        cursor.execute("SELECT to_regclass('public.reference_documents');")
        if cursor.fetchone()[0] != "reference_documents":
            raise RuntimeError("Reference-document registry was not created.")
        print(f"Applied reference-document registry to {database_name}.")
    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()


if __name__ == "__main__":
    main()
