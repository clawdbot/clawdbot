import { listExistingAgentDatabaseTargets } from "../commands/doctor-session-sqlite-readers.js";
import { getRuntimeConfig } from "../config/config.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { parseInboundMediaUri } from "./media-reference.js";

const INBOUND_MEDIA_URI_PATTERN = /media:\/\/inbound\/[^\s"'<>\\\]]+/gi;

function tryParseInboundMediaId(source: string): string | undefined {
  try {
    return parseInboundMediaUri(source)?.id;
  } catch {
    return undefined;
  }
}

export function collectTranscriptReferencedInboundMediaIds(
  candidateIds: ReadonlySet<string>,
): Set<string> | null {
  const referenced = new Set<string>();
  if (candidateIds.size === 0) {
    return referenced;
  }
  try {
    for (const target of listExistingAgentDatabaseTargets(getRuntimeConfig(), process.env)) {
      const database = openNodeSqliteDatabase(target.sqlitePath, { readOnly: true });
      try {
        if (!tableExists(database, "transcript_events")) {
          continue;
        }
        const rows = database
          .prepare(
            "SELECT event_json FROM transcript_events WHERE instr(event_json, 'media://inbound/') > 0",
          )
          .iterate() as Iterable<{ event_json?: unknown }>;
        for (const row of rows) {
          if (typeof row.event_json !== "string") {
            continue;
          }
          for (const match of row.event_json.matchAll(INBOUND_MEDIA_URI_PATTERN)) {
            const id = tryParseInboundMediaId(match[0]);
            if (id && candidateIds.has(id)) {
              referenced.add(id);
            }
          }
          if (referenced.size === candidateIds.size) {
            break;
          }
        }
      } finally {
        database.close();
      }
      if (referenced.size === candidateIds.size) {
        break;
      }
    }
    return referenced;
  } catch {
    return null;
  }
}
