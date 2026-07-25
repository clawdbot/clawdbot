import type {
  SessionAccessScope,
  SessionEntrySummary,
  SessionTranscriptInstance,
} from "./session-accessor.sqlite-contract.js";
import {
  listSqliteSessionEntriesByStatus,
  listSqliteSessionTranscriptInstances,
} from "./session-accessor.sqlite.js";
import type { SessionEntry } from "./types.js";

type SessionEntryListScope = Partial<Omit<SessionAccessScope, "sessionKey">>;
type SessionEntryStatus = NonNullable<SessionEntry["status"]>;

export type { SessionTranscriptInstance } from "./session-accessor.sqlite-contract.js";

/** Lists entries selected by the indexed normalized session status. */
export function listSessionEntriesByStatus(
  scope: SessionEntryListScope,
  statuses: readonly SessionEntryStatus[],
): SessionEntrySummary[] {
  return listSqliteSessionEntriesByStatus(scope, statuses);
}

/** Lists every retained transcript instance, including prior ids for rotated logical sessions. */
export function listSessionTranscriptInstances(
  scope: SessionEntryListScope = {},
): SessionTranscriptInstance[] {
  return listSqliteSessionTranscriptInstances(scope);
}
