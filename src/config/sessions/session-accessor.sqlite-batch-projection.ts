import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntryBatchProjectionUpdate } from "./session-accessor.sqlite-contract.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  readSqliteSessionEntryStore,
  sqliteSessionEntriesEqual,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import type { SqliteSessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySqliteSessionEntryMaintenance,
  finalizeSqliteSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

/**
 * Projects inserts, replacements, and canonical rekeys from one detached store
 * snapshot, then commits the accepted mutations in one validated transaction.
 */
export async function applySqliteSessionEntryBatchProjection<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    store: Record<string, SessionEntry>,
  ) => Promise<SessionEntryBatchProjectionUpdate<T>> | SessionEntryBatchProjectionUpdate<T>;
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? "",
    storePath: params.storePath,
  });
  const committed = await runExclusiveSqliteSessionWrite(resolved, async () => {
    const databaseOptions = toDatabaseOptions(resolved);
    const database = openOpenClawAgentDatabase(databaseOptions);
    const before = readSqliteSessionEntryStore(database);
    const visibleStore = Object.fromEntries(
      Object.entries(before).flatMap(([sessionKey, entry]) =>
        isInternalSessionEffectsKey(sessionKey)
          ? []
          : [[sessionKey, cloneSessionEntry(entry)] as const],
      ),
    );
    const operation = await params.update(visibleStore);
    const mutations = [...(operation.mutations ?? [])].map((mutation) =>
      Object.assign({}, mutation, {
        previousSessionKeys: uniqueStrings(
          (mutation.previousSessionKeys ?? []).map((key) => key.trim()).filter(Boolean),
        ),
        sessionKey: mutation.sessionKey.trim(),
      }),
    );
    if (mutations.length === 0) {
      return { maintenancePlans: [], result: operation.result };
    }

    const claimedKeys = new Set<string>();
    for (const mutation of mutations) {
      if (!mutation.sessionKey) {
        throw new Error("Session entry batch projection requires a canonical key");
      }
      const touchedKeys = [mutation.sessionKey, ...mutation.previousSessionKeys];
      for (const sessionKey of touchedKeys) {
        if (claimedKeys.has(sessionKey)) {
          throw new Error(`Session entry batch projection overlaps at ${sessionKey}`);
        }
        claimedKeys.add(sessionKey);
      }
      for (const previousKey of mutation.previousSessionKeys) {
        if (!before[previousKey]) {
          throw new Error(
            `Session entry batch projection cannot replace missing alias ${previousKey}`,
          );
        }
      }
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    const previous = new Map<string, SessionEntry>();
    const current = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        for (const sessionKey of claimedKeys) {
          const transactionEntry = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
          if (!sqliteSessionEntriesEqual(transactionEntry, before[sessionKey])) {
            throw new Error(
              `SQLite session entry changed before batch projection for ${sessionKey}`,
            );
          }
        }
        for (const mutation of mutations) {
          const canonicalBefore = before[mutation.sessionKey];
          const aliasEntries = mutation.previousSessionKeys.flatMap((sessionKey) => {
            const entry = before[sessionKey];
            return entry ? [{ entry, sessionKey }] : [];
          });
          const selectedBefore = [
            ...(canonicalBefore ? [canonicalBefore] : []),
            ...aliasEntries.map(({ entry }) => entry),
          ].toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
          if (canonicalBefore) {
            previous.set(mutation.sessionKey, canonicalBefore);
          }
          for (const { entry, sessionKey } of aliasEntries) {
            previous.set(sessionKey, entry);
          }
          writeSessionEntry(transactionDb, mutation.sessionKey, cloneSessionEntry(mutation.entry), {
            previousEntry: selectedBefore ?? null,
          });
          deleteLegacySessionEntryRows(
            transactionDb,
            mutation.previousSessionKeys,
            mutation.sessionKey,
            { rehomeMembers: selectedBefore?.sessionId === mutation.entry.sessionId },
          );
          current.set(mutation.sessionKey, mutation.entry);
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance ?? true,
            storePath: params.storePath,
          }),
        );
      },
      databaseOptions,
      { operationLabel: "session.entry-batch-projection" },
    );
    emitCommittedSessionIdentityDiff(previous, current);
    return { maintenancePlans, result: operation.result };
  });
  await finalizeSqliteSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    resolved,
    committed.maintenancePlans,
  );
  return committed.result;
}
