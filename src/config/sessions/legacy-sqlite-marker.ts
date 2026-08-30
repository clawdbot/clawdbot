/** Legacy marker codec retained only for artifacts, migration, and plugin SDK compatibility. */
import path from "node:path";

export type SqliteSessionFileMarker = {
  agentId: string;
  sessionId: string;
  storePath: string;
};

const SQLITE_SESSION_FILE_MARKER_RE = /^sqlite:([^:]+):([^:]+):(.*)$/;

export function formatSqliteSessionFileMarker(marker: SqliteSessionFileMarker): string {
  return `sqlite:${marker.agentId}:${marker.sessionId}:${path.resolve(marker.storePath)}`;
}

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
  return { agentId: match[1], sessionId: match[2], storePath: match[3] };
}

export function sqliteSessionFileMarkerMatchesSession(
  sessionFile: string | undefined,
  sessionId: string,
): boolean {
  return parseSqliteSessionFileMarker(sessionFile)?.sessionId === sessionId;
}

export function sqliteSessionFileMarkerMatchesTarget(
  sessionFile: string | undefined,
  target: SqliteSessionFileMarker,
): boolean {
  const marker = parseSqliteSessionFileMarker(sessionFile);
  return (
    marker?.agentId === target.agentId &&
    marker.sessionId === target.sessionId &&
    path.resolve(marker.storePath) === path.resolve(target.storePath)
  );
}
