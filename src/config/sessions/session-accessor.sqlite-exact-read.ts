import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSessionEntry(scope: SessionEntryReadScope): ExactSessionEntry | undefined {
  return loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: [scope.sessionKey],
    readOnly: false,
  })[0];
}

/** Reads exact candidates for one logical session through a single store admission. */
export function loadExactSessionEntryCandidates(
  scope: Omit<SessionEntryReadScope, "sessionKey"> & {
    sessionKeys: readonly string[];
    readOnly: boolean;
  },
): ExactSessionEntry[] {
  const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
  const [sessionKey] = sessionKeys;
  if (!sessionKey) {
    return [];
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey });
  // Alias candidates share a store; fresh handles must not rescan canonical state per key.
  const read = (database: Pick<OpenClawAgentDatabase, "agentId" | "db">) =>
    sessionKeys.flatMap((key) => {
      const entry = readExactSessionEntryRowValidated(database, key, scope.projection)?.entry;
      return entry ? [{ sessionKey: key, entry }] : [];
    });
  if (!scope.readOnly) {
    return read(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
  }
  const result = withOpenClawAgentDatabaseReadOnly(read, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Exact persisted-key probe on the read-only handle, for per-row hot paths. */
export function loadExactSessionEntryReadOnly(
  scope: SessionEntryReadScope,
): ExactSessionEntry | undefined {
  return loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: [scope.sessionKey],
    readOnly: true,
  })[0];
}

/** Read requested keys through synchronous store/projection groups. */
export function loadExactSessionEntryCandidatesReadOnlyBatch(
  scopes: readonly (Omit<SessionEntryReadScope, "sessionKey"> & {
    sessionKeys: readonly string[];
  })[],
): Array<Result<ExactSessionEntry[], unknown>> {
  const results: Array<Result<ExactSessionEntry[], unknown>> = scopes.map(() => ok([]));
  const groups = new Map<
    string,
    {
      options: OpenClawAgentDatabaseOptions;
      projection: SessionEntryReadScope["projection"];
      requests: Array<{ index: number; sessionKeys: string[] }>;
    }
  >();
  for (const [index, scope] of scopes.entries()) {
    const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
    const [sessionKey] = sessionKeys;
    if (!sessionKey) {
      continue;
    }
    try {
      const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey }));
      const groupKey = [
        options.agentId,
        resolveOpenClawAgentSqlitePath(options),
        scope.projection ?? "full",
      ].join("\u0000");
      const group = groups.get(groupKey) ?? { options, projection: scope.projection, requests: [] };
      group.requests.push({ index, sessionKeys });
      groups.set(groupKey, group);
    } catch (error) {
      results[index] = err(error);
    }
  }
  for (const group of groups.values()) {
    try {
      withOpenClawAgentDatabaseReadOnly((database) => {
        // Admission failures affect this store; an invalid requested row must not
        // suppress healthy logical targets after a warm handle was validated.
        assertCanonicalSqliteSessionKeysCurrent(database);
        const entries = new Map<string, Result<ExactSessionEntry | undefined, unknown>>();
        const readEntry = (sessionKey: string): Result<ExactSessionEntry | undefined, unknown> => {
          const cached = entries.get(sessionKey);
          if (cached) {
            return cached;
          }
          let result: Result<ExactSessionEntry | undefined, unknown>;
          try {
            const entry = readExactSessionEntryRowValidated(
              database,
              sessionKey,
              group.projection,
            )?.entry;
            result = ok(entry ? { sessionKey, entry } : undefined);
          } catch (error) {
            result = err(error);
          }
          entries.set(sessionKey, result);
          return result;
        };
        for (const { index, sessionKeys } of group.requests) {
          const matches: ExactSessionEntry[] = [];
          results[index] = ok(matches);
          for (const sessionKey of sessionKeys) {
            const entry = readEntry(sessionKey);
            if (!entry.ok) {
              results[index] = err(entry.error);
              break;
            }
            if (entry.value) {
              matches.push(entry.value);
            }
          }
        }
      }, group.options);
    } catch (error) {
      for (const { index } of group.requests) {
        results[index] = err(error);
      }
    }
  }
  return results;
}
