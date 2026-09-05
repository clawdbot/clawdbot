import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  normalizeLifecycleTarget,
  readSessionIdentitySnapshot,
  resolveLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  formatLegacySqliteSessionMarkerForScope,
  normalizeSqliteSessionKey,
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActor } from "./session-entry-provenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type RestartTombstoneRecoveryResult =
  | {
      status: "created" | "existing";
      sourceEntry: SessionEntry;
      successorEntry: SessionEntry;
      successorKey: string;
    }
  | {
      status: "conflict";
      reason:
        | "not-tombstoned"
        | "source-changed"
        | "successor-missing"
        | "target-exists"
        | "transcript-missing";
    };

/**
 * Atomically clones a tombstoned transcript, creates its successor, and records
 * the revisioned source archive/link transition in the same agent database.
 */
export async function recoverSessionEntryFromRestartTombstone(params: {
  agentId: string;
  archivedBy?: SessionActor;
  expected: {
    cycleId: string;
    lifecycleRevision?: string;
    pluginOwnerId?: string;
    revision: number;
    sessionId: string;
  };
  commitGuard?: () => void;
  sourceTarget: { canonicalKey: string; storeKeys: readonly string[] };
  storePath: string;
  successorEntry: InternalSessionEntry & { sessionId: string };
  successorTarget: { canonicalKey: string; storeKeys: readonly string[] };
}): Promise<RestartTombstoneRecoveryResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const sourceTarget = normalizeLifecycleTarget({
    ...params.sourceTarget,
    storeKeys: [...params.sourceTarget.storeKeys],
  });
  const successorTarget = normalizeLifecycleTarget({
    ...params.successorTarget,
    storeKeys: [...params.successorTarget.storeKeys],
  });
  let previousIdentity = new Map<string, SessionEntry>();
  let currentIdentity = new Map<string, SessionEntry>();
  let result: RestartTombstoneRecoveryResult = {
    status: "conflict",
    reason: "source-changed",
  };

  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      const source = resolveLifecyclePrimaryEntry(database, sourceTarget)?.entry as
        | InternalSessionEntry
        | undefined;
      const recovery = source?.mainRestartRecovery;
      const tombstone = recovery?.tombstone;
      if (!source?.sessionId || !recovery || !tombstone) {
        result = { status: "conflict", reason: "not-tombstoned" };
        return;
      }

      const recoveredSessionKey = tombstone.recoveredSessionKey;
      const recoveredSessionId = tombstone.recoveredSessionId;
      if (recoveredSessionKey || recoveredSessionId) {
        if (!recoveredSessionKey || !recoveredSessionId) {
          result = { status: "conflict", reason: "successor-missing" };
          return;
        }
        const linked = resolveLifecyclePrimaryEntry(
          database,
          normalizeLifecycleTarget({
            canonicalKey: recoveredSessionKey,
            storeKeys: [recoveredSessionKey],
          }),
        )?.entry;
        if (!linked || linked.sessionId !== recoveredSessionId) {
          result = { status: "conflict", reason: "successor-missing" };
          return;
        }
        result = {
          status: "existing",
          sourceEntry: cloneSessionEntry(source),
          successorEntry: cloneSessionEntry(linked),
          successorKey: recoveredSessionKey,
        };
        return;
      }

      if (
        source.sessionId !== params.expected.sessionId ||
        source.lifecycleRevision !== params.expected.lifecycleRevision ||
        recovery.cycleId !== params.expected.cycleId ||
        recovery.revision !== params.expected.revision ||
        source.pluginOwnerId !== params.expected.pluginOwnerId
      ) {
        result = { status: "conflict", reason: "source-changed" };
        return;
      }
      if (resolveLifecyclePrimaryEntry(database, successorTarget)?.entry) {
        result = { status: "conflict", reason: "target-exists" };
        return;
      }

      const sourceEvents = loadTranscriptEventsFromDatabase(database, source.sessionId);
      const header = sourceEvents.find(
        (event): event is Record<string, unknown> => isRecord(event) && event.type === "session",
      );
      if (!header) {
        result = { status: "conflict", reason: "transcript-missing" };
        return;
      }

      const successorSessionId = params.successorEntry.sessionId;
      const parentSession = formatLegacySqliteSessionMarkerForScope({
        ...resolved,
        sessionId: source.sessionId,
        sessionKey: normalizeSqliteSessionKey(sourceTarget.canonicalKey),
      });
      appendTranscriptEventsInTransaction(
        database,
        {
          ...resolved,
          sessionId: successorSessionId,
          sessionKey: normalizeSqliteSessionKey(successorTarget.canonicalKey),
        },
        [
          {
            ...createSessionTranscriptHeader({
              cwd: typeof header.cwd === "string" ? header.cwd : undefined,
              sessionId: successorSessionId,
            }),
            parentSession,
          },
          ...sourceEvents.filter((event) => !(isRecord(event) && event.type === "session")),
        ],
      );

      const now = Date.now();
      const nextSource: InternalSessionEntry = {
        ...source,
        mainRestartRecovery: {
          ...recovery,
          revision: recovery.revision + 1,
          tombstone: {
            ...tombstone,
            recoveredSessionId: successorSessionId,
            recoveredSessionKey: successorTarget.canonicalKey,
          },
        },
        archivedAt: source.archivedAt ?? now,
        ...(source.archiveReason
          ? { archiveReason: source.archiveReason }
          : source.archivedAt === undefined
            ? { archiveReason: "restart-recovery" as const }
            : {}),
        ...(source.archivedBy === undefined && params.archivedBy
          ? { archivedBy: params.archivedBy }
          : {}),
        updatedAt: Math.max(now, (source.updatedAt ?? 0) + 1),
      };
      delete nextSource.pinnedAt;

      params.commitGuard?.();

      const identityKeys = [sourceTarget.canonicalKey, successorTarget.canonicalKey];
      previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
      writeSessionEntry(database, successorTarget.canonicalKey, params.successorEntry);
      writeSessionEntry(database, sourceTarget.canonicalKey, nextSource, {
        previousEntry: source,
      });
      currentIdentity = readSessionIdentitySnapshot(database, identityKeys);
      result = {
        status: "created",
        sourceEntry: cloneSessionEntry(nextSource),
        successorEntry: cloneSessionEntry(params.successorEntry),
        successorKey: successorTarget.canonicalKey,
      };
    }, toDatabaseOptions(resolved));
  });

  emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
  return result;
}
