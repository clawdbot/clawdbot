import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
} from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  readSessionEntryStore,
  type ResolvedSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";
import type { SessionEntryReplacement } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryCanonicalReplacement = SessionEntryReplacement & {
  previousSessionKeys: readonly string[];
};

type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

type ReplacementProjectionOptions = {
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
};

type ReplacementProjectionParams<T, TReplacement> = ReplacementProjectionOptions & {
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) =>
    | Promise<{ result: T; replacements?: Iterable<TReplacement> }>
    | { result: T; replacements?: Iterable<TReplacement> };
};

async function applySqliteSessionEntryReplacementProjection<T, TReplacement>(
  params: ReplacementProjectionParams<T, TReplacement>,
  normalize: (replacements: Iterable<TReplacement> | undefined) => SqliteSessionEntryReplacement[],
): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
  });
  const committed = await runPreparedSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
    const selectedStatuses = params.statuses ? new Set(params.statuses) : undefined;
    const selected = selectedStatuses
      ? readSessionEntriesByStatus(database, [...selectedStatuses], params.sessionKeys)
      : selectedKeys
        ? [...selectedKeys].map((sessionKey) => ({ sessionKey }))
        : Object.keys(readSessionEntryStore(database)).map((sessionKey) => ({ sessionKey }));
    const expectedRows = new Map<string, ResolvedSessionEntryRow>();
    const entries = selected.flatMap(({ sessionKey }) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      if (!row) {
        if (!selectedKeys || selectedStatuses) {
          throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
        }
        return [];
      }
      if (selectedStatuses && (!row.entry.status || !selectedStatuses.has(row.entry.status))) {
        return [];
      }
      // Pair the detached entry and CAS bytes from one row; separate reads can
      // otherwise bless stale data with a newer writer's comparison token.
      expectedRows.set(sessionKey, row);
      return [{ entry: cloneSessionEntry(row.entry), sessionKey }];
    });
    const replacementAuthorityKeys = selectedStatuses
      ? new Set(entries.map(({ sessionKey }) => sessionKey))
      : selectedKeys;
    const operation = await params.update(entries);
    const replacements = normalize(operation.replacements);
    const claimedCanonicalKeys = new Set<string>();
    for (const replacement of replacements) {
      const previousSessionKeys = replacement.previousSessionKeys;
      const canonical = previousSessionKeys !== undefined;
      if (canonical && !replacement.sessionKey) {
        throw new Error("Session entry replacement requires a key");
      }
      if (
        canonical &&
        [replacement.sessionKey, ...(previousSessionKeys ?? [])].some(isInternalSessionEffectsKey)
      ) {
        throw new Error("Session entry canonical replacement cannot target internal effects rows");
      }
      for (const sessionKey of [replacement.sessionKey, ...(previousSessionKeys ?? [])]) {
        if (replacementAuthorityKeys && !replacementAuthorityKeys.has(sessionKey)) {
          const selectionName = selectedStatuses ? "row" : "key";
          throw new Error(
            `Session entry replacement is outside the selected ${selectionName} set: ${sessionKey}`,
          );
        }
        if (canonical) {
          if (claimedCanonicalKeys.has(sessionKey)) {
            throw new Error(`Session entry replacements overlap at ${sessionKey}`);
          }
          claimedCanonicalKeys.add(sessionKey);
        }
      }
      if (canonical) {
        for (const previousSessionKey of previousSessionKeys) {
          if (!expectedRows.has(previousSessionKey)) {
            throw new Error(
              `Session entry canonical projection cannot replace missing alias ${previousSessionKey}`,
            );
          }
        }
      }
    }

    const applicable = replacements.filter(
      (replacement) => replacement.previousSessionKeys || expectedRows.has(replacement.sessionKey),
    );
    if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
      throw new Error("session entry replacements did not persist any rows");
    }
    if (applicable.length === 0) {
      return {
        deletedEntries: [],
        commit: () => ({ maintenancePlans: [], result: operation.result }),
      };
    }
    const validationKeys = new Set(
      applicable.flatMap((replacement) => [
        replacement.sessionKey,
        ...(replacement.previousSessionKeys ?? []),
      ]),
    );

    const maintenancePlans: SessionEntryMaintenancePlan[] = [];
    const previous = new Map<string, SessionEntry>();
    const current = new Map<string, SessionEntry>();
    const deletedOwners = [...validationKeys].flatMap((sessionKey) => {
      const entry = expectedRows.get(sessionKey)?.entry;
      return entry && !applicable.some((replacement) => replacement.sessionKey === sessionKey)
        ? [{ entry, sessionKey }]
        : [];
    });
    return {
      deletedEntries: deletedOwners,
      commit: () => {
        runOpenClawAgentWriteTransaction(
          (transactionDb) => {
            const transactionEntries = new Map<string, SessionEntry>();
            for (const sessionKey of validationKeys) {
              const transactionRow = readExactSessionEntryRow(transactionDb, sessionKey);
              const expectedRow = expectedRows.get(sessionKey);
              if (
                transactionRow?.row.entry_json !== expectedRow?.row.entry_json ||
                !sqliteSessionEntriesEqual(transactionRow?.entry, expectedRow?.entry)
              ) {
                throw new Error(
                  `SQLite session entry changed before replacement for ${sessionKey}`,
                );
              }
              if (transactionRow) {
                transactionEntries.set(sessionKey, transactionRow.entry);
              }
            }
            for (const replacement of applicable) {
              const sourceEntries = [
                replacement.sessionKey,
                ...(replacement.previousSessionKeys ?? []),
              ].flatMap((sessionKey) => {
                const entry = transactionEntries.get(sessionKey);
                return entry ? [{ entry, sessionKey }] : [];
              });
              const selectedBefore = sourceEntries.toSorted(
                (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
              )[0]?.entry;
              for (const { entry, sessionKey } of sourceEntries) {
                previous.set(sessionKey, entry);
              }
              writeSessionEntry(
                transactionDb,
                replacement.sessionKey,
                cloneSessionEntry(replacement.entry),
                { previousEntry: selectedBefore ?? null },
              );
              deleteLegacySessionEntryRows(
                transactionDb,
                [...(replacement.previousSessionKeys ?? [])],
                replacement.sessionKey,
                { rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId },
              );
              current.set(replacement.sessionKey, replacement.entry);
            }
            maintenancePlans.push(
              applySessionEntryMaintenance(transactionDb, {
                activeSessionKey: params.activeSessionKey ?? "",
                archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                skipMaintenance: params.skipMaintenance ?? true,
                storePath: params.storePath,
              }),
            );
          },
          toDatabaseOptions(resolved),
          { operationLabel: "session.entry-replacements" },
        );
        emitCommittedSessionIdentityDiff(previous, current);
        return { maintenancePlans, result: operation.result };
      },
    };
  });
  await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    resolved,
    committed.maintenancePlans,
  );
  return committed.result;
}

export async function applySessionEntryExactReplacements<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  return await applySqliteSessionEntryReplacementProjection(params, (replacements) =>
    [...(replacements ?? [])].map(({ entry, sessionKey }) => ({
      entry,
      sessionKey,
    })),
  );
}

/** Internal alias-aware owner; public SDK replacements remain exact-key only. */
export async function applySessionEntryCanonicalReplacements<T>(
  params: ReplacementProjectionParams<T, SessionEntryCanonicalReplacement>,
): Promise<T> {
  return await applySqliteSessionEntryReplacementProjection(
    {
      ...params,
      ...(params.sessionKeys
        ? {
            sessionKeys: uniqueStrings(params.sessionKeys.map((key) => key.trim()).filter(Boolean)),
          }
        : {}),
    },
    (replacements) =>
      [...(replacements ?? [])].map((replacement) => ({
        entry: replacement.entry,
        previousSessionKeys: uniqueStrings(
          replacement.previousSessionKeys.map((key) => key.trim()).filter(Boolean),
        ),
        sessionKey: replacement.sessionKey.trim(),
      })),
  );
}
