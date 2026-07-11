/** SQLite transcript sessionFile marker helpers shared by session runtime readers. */
import path from "node:path";

export type SqliteSessionFileMarker = {
  agentId: string;
  sessionId: string;
  storePath: string;
};

const SQLITE_SESSION_FILE_MARKER_RE = /^sqlite:([^:]+):([^:]+):(.*)$/;

/** Formats the canonical sessionFile marker for SQLite-backed transcripts. */
export function formatSqliteSessionFileMarker(marker: SqliteSessionFileMarker): string {
  return `sqlite:${marker.agentId}:${marker.sessionId}:${path.resolve(marker.storePath)}`;
}

/** Parses a SQLite-backed transcript sessionFile marker. */
export function parseSqliteSessionFileMarker(
  sessionFile: string | undefined,
): SqliteSessionFileMarker | undefined {
  const marker = sessionFile?.trim();
  if (!marker?.startsWith("sqlite:")) {
    return undefined;
  }
  const match = SQLITE_SESSION_FILE_MARKER_RE.exec(marker);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return {
    agentId: match[1],
    sessionId: match[2],
    storePath: match[3],
  };
}

/** Checks whether a sessionFile marker points at the expected session id. */
export function sqliteSessionFileMarkerMatchesSession(
  sessionFile: string | undefined,
  sessionId: string,
): boolean {
  return parseSqliteSessionFileMarker(sessionFile)?.sessionId === sessionId;
}
