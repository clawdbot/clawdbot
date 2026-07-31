import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export const LEGACY_MEMORY_FTS_MATCH_TABLE = "memory_core_legacy_fts_matches";

export const CREATE_LEGACY_MEMORY_FTS_MATCH_TABLE_SQL = `
  CREATE TEMP TABLE ${LEGACY_MEMORY_FTS_MATCH_TABLE} (
    id TEXT PRIMARY KEY,
    exact INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
`;

/** Build the statement that materializes canonical FTS rows matching legacy chunk ids. */
export function buildLegacyMemoryFtsMatchSql(schema: string): string {
  return `
    INSERT INTO temp.${LEGACY_MEMORY_FTS_MATCH_TABLE} (id, exact)
    SELECT canonical.id,
           MAX(CASE
             WHEN canonical.text IS legacy.text
              AND canonical.path IS legacy.path
              AND canonical.source IS legacy.source
              AND canonical.model IS legacy.model
              AND canonical.start_line IS legacy.start_line
              AND canonical.end_line IS legacy.end_line
             THEN 1 ELSE 0
           END)
    -- SQLite preserves CROSS JOIN order, keeping the unindexed FTS scan outer
    -- so both chunk tables use indexed id lookups instead of rescanning FTS.
    FROM main.${MEMORY_INDEX_FTS_TABLE} AS canonical
    CROSS JOIN ${schema}.chunks AS legacy
    CROSS JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk
    WHERE legacy.id = canonical.id
      AND chunk.id = legacy.id
    GROUP BY canonical.id;
  `;
}

/** Build the statement that copies legacy FTS rows absent from the canonical match table. */
export function buildLegacyMemoryFtsCopySql(schema: string): string {
  return `
    INSERT INTO main.${MEMORY_INDEX_FTS_TABLE} (
      text, id, path, source, model, start_line, end_line
    )
    SELECT legacy.text, legacy.id, legacy.path, legacy.source, legacy.model,
           legacy.start_line, legacy.end_line
    FROM ${schema}.chunks AS legacy
    JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
    WHERE NOT EXISTS (
      SELECT 1 FROM temp.${LEGACY_MEMORY_FTS_MATCH_TABLE} AS canonical
      WHERE canonical.id = legacy.id
    );
  `;
}
