import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryJson,
  readExactSessionEntryRow,
  readSessionEntryStore,
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
  runExclusiveSqliteSessionWrite,
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
  const committed = await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
    const selectedStatuses = params.statuses ? new Set(params.statuses) : undefined;
    const entries = selectedStatuses
      ? readSessionEntriesByStatus(database, [...selectedStatuses], params.sessionKeys)
      : selectedKeys
        ? [...selectedKeys].flatMap((sessionKey) => {
            const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
            return entry ? [{ entry: cloneSessionEntry(entry), sessionKey }] : [];
          })
        : Object.entries(readSessionEntryStore(database)).map(([sessionKey, entry]) => ({
            entry: cloneSessionEntry(entry),
            sessionKey,
          }));
    const replacementAuthorityKeys = selectedStatuses
      ? new Set(entries.map(({ sessionKey }) => sessionKey))
      : selectedKeys;
    // Compare persisted row bytes, never a hydrated entry. Participants and owner live in
    // their own table/columns, and each selection reader projects a different subset of them,
    // so an entry-object compare can differ from the transaction re-read with no write at all
    // and wedge the row's repairs forever.
    const expectedEntryJson = new Map(
      entries.map(({ sessionKey }) => {
        const rawEntryJson = readExactSessionEntryJson(database, sessionKey);
        if (rawEntryJson === undefined) {
          // The row vanished between hydrating the snapshot and reading its bytes. Fail closed:
          // a selected key must hold bytes, or a later missing-vs-missing compare would pass and
          // rewrite the stale entry into a concurrently deleted key.
          throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
        }
        return [sessionKey, rawEntryJson];
      }),
    );
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
          if (!expectedEntryJson.has(previousSessionKey)) {
            throw new Error(
              `Session entry canonical projection cannot replace missing alias ${previousSessionKey}`,
            );
          }
        }
      }
    }

    const applicable = replacements.filter(
      (replacement) =>
        replacement.previousSessionKeys || expectedEntryJson.has(replacement.sessionKey),
    );
    if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
      throw new Error("session entry replacements did not persist any rows");
    }
    if (applicable.length === 0) {
      return { maintenancePlans: [], result: operation.result };
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
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        const transactionEntries = new Map<string, SessionEntry>();
        for (const sessionKey of validationKeys) {
          const transactionRow = readExactSessionEntryRow(transactionDb, sessionKey);
          if (transactionRow?.row.entry_json !== expectedEntryJson.get(sessionKey)) {
            throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
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
