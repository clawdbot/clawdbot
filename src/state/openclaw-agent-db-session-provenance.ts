import type { DatabaseSync } from "node:sqlite";

function readMigratedEntry(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function addSessionProvenanceColumns(
  db: DatabaseSync,
  columns: ReadonlySet<string> | null | undefined,
): void {
  if (columns && !columns.has("session_entry_provenance")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1));",
    );
  }
  if (columns && !columns.has("acp_owned")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1));",
    );
  }
  if (columns && !columns.has("plugin_owner_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN plugin_owner_id TEXT;");
  }
  if (columns && !columns.has("hook_external_content_source")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook'));",
    );
  }
}

export function backfillSessionEntryProvenance(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 8) {
    return;
  }
  const hasSessionEntries = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_entries'")
    .get();
  const hasSessions = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get();
  if (!hasSessionEntries || !hasSessions) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT se.session_id, se.entry_json
       FROM session_entries AS se
       INNER JOIN sessions AS s
         ON s.session_id = se.session_id AND s.session_key = se.session_key;`,
    )
    .all() as Array<{ entry_json?: unknown; session_id?: unknown }>;
  const update = db.prepare(`
    UPDATE sessions
    SET session_entry_provenance = 1, acp_owned = ?, plugin_owner_id = ?,
        hook_external_content_source = ?
    WHERE session_id = ?;
  `);
  for (const row of rows) {
    const sessionId = normalizedText(row.session_id);
    const entry = readMigratedEntry(row.entry_json);
    if (!sessionId || !entry) {
      continue;
    }
    const hookSource = normalizedText(entry.hookExternalContentSource);
    const acp = entry.acp;
    update.run(
      acp && typeof acp === "object" && !Array.isArray(acp) ? 1 : 0,
      normalizedText(entry.pluginOwnerId),
      hookSource === "gmail" || hookSource === "webhook" ? hookSource : null,
      sessionId,
    );
  }
}

export function backfillTranscriptMutationWatermarks(db: DatabaseSync): void {
  const transcriptTable = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("transcript_events") as { ok?: unknown } | undefined;
  if (transcriptTable?.ok !== 1) {
    return;
  }
  db.exec(`
    UPDATE sessions
    SET
      transcript_updated_at = COALESCE(
        transcript_updated_at,
        (SELECT MAX(transcript_events.created_at)
         FROM transcript_events
         WHERE transcript_events.session_id = sessions.session_id)
      ),
      transcript_observed_at = COALESCE(transcript_observed_at, updated_at)
    WHERE EXISTS (
      SELECT 1 FROM transcript_events
      WHERE transcript_events.session_id = sessions.session_id
    );
  `);
}
