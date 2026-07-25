import { randomUUID } from "node:crypto";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
} from "./session-accessor.sqlite-contract.js";
import {
  deleteLegacySessionEntryRows,
  normalizeSqliteLifecycleTarget,
  readSqliteSessionIdentitySnapshot,
  rehomeSqliteSessionWindows,
  resolveSqliteLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import type { SqliteSessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySqliteSessionEntryMaintenance,
  finalizeSqliteSessionEntryMaintenancePlansBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import {
  buildSqliteForkedChildTranscriptEvents,
  estimateSqliteTranscriptPromptTokens,
  resolveSqliteParentForkDecision,
  resolveSqliteParentForkSourceTranscript,
  type SqliteParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadSqliteTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  formatSqliteSessionMarkerForScope,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry, resolveFreshSessionTotalTokens } from "./types.js";

// Parent-session fork owner: decision, transcript copy, and child entry commit.

export async function forkSqliteSessionTranscriptFromParent(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const target = params.targetStorePath
    ? resolveSqliteScope({ sessionKey: params.sessionKey, storePath: params.targetStorePath })
    : resolved;
  const crossDatabase =
    target.agentId !== resolved.agentId || (target.path ?? "") !== (resolved.path ?? "");
  if (!crossDatabase) {
    return await runExclusiveSqliteSessionWrite(resolved, async () => {
      let result: ForkSessionFromParentTranscriptResult = { status: "failed" };
      runOpenClawAgentWriteTransaction((database) => {
        result = forkSqliteParentTranscriptInTransaction(database, resolved, {
          parentEntry: params.parentEntry,
          parentSessionKey: params.parentSessionKey,
          targetSessionId: params.targetSessionId,
          targetSessionKey: params.sessionKey,
        });
      }, toDatabaseOptions(resolved));
      return result;
    });
  }
  // Cross-agent fork (worktree/cross-agent sessions.create): parent rows live
  // in the source agent database while the child transcript must be owned by
  // the target agent's database. Two databases cannot share one transaction,
  // so read the parent branch first, then write the child under the target's
  // exclusive session write lock.
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const source = resolveSqliteParentForkSourceTranscript(
    loadSqliteTranscriptEventsFromDatabase(sourceDatabase, params.parentEntry.sessionId),
  );
  if (!source) {
    return { status: "failed" };
  }
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  return await runExclusiveSqliteSessionWrite(target, async () => {
    const sessionId = params.targetSessionId ?? randomUUID();
    const targetScope = {
      ...target,
      sessionId,
      sessionKey: normalizeSqliteSessionKey(params.sessionKey),
    };
    const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
    runOpenClawAgentWriteTransaction((database) => {
      writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
        parentSessionFile,
        source,
      });
    }, toDatabaseOptions(target));
    return { status: "created", transcript: { sessionFile, sessionId } };
  });
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSqliteSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const parentTarget = normalizeSqliteLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeSqliteLifecycleTarget(params.sessionTarget);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const parent = resolveSqliteLifecyclePrimaryEntry(database, parentTarget);
    if (!parent?.entry.sessionId) {
      return { status: "missing-parent" };
    }

    const existing = resolveSqliteLifecyclePrimaryEntry(database, sessionTarget);
    const base = existing?.entry ?? params.fallbackEntry;
    if (!base) {
      return { status: "missing-entry" };
    }

    if (params.skipForkWhen?.(cloneSessionEntry(base))) {
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch: params.skipPatch?.(cloneSessionEntry(base)),
        resolved,
      });
      return {
        status: "skipped",
        reason: "existing-entry",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
      };
    }

    const needsTranscriptTokenEstimate =
      typeof resolveFreshSessionTotalTokens(parent.entry) !== "number" &&
      typeof parent.entry.sessionId === "string" &&
      parent.entry.sessionId.length > 0;
    const transcriptParentTokens = needsTranscriptTokenEstimate
      ? estimateSqliteTranscriptPromptTokens(
          loadSqliteTranscriptEventsFromDatabase(database, parent.entry.sessionId),
        )
      : undefined;
    const decision = resolveSqliteParentForkDecision(parent.entry, transcriptParentTokens);
    if (decision.status === "skip") {
      const patch = params.decisionSkipPatch?.({
        decision,
        entry: cloneSessionEntry(base),
        parentEntry: cloneSessionEntry(parent.entry),
      });
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch,
        resolved,
      });
      return {
        status: "skipped",
        reason: "decision-skip",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
        decision,
      };
    }

    let result: ForkSessionEntryFromParentTargetResult = { status: "failed" };
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const freshParent = resolveSqliteLifecyclePrimaryEntry(writeDatabase, parentTarget)?.entry;
      if (!freshParent?.sessionId) {
        result = { status: "missing-parent" };
        return;
      }
      const freshExisting = resolveSqliteLifecyclePrimaryEntry(writeDatabase, sessionTarget);
      const freshBase = freshExisting?.entry ?? params.fallbackEntry;
      if (!freshBase) {
        result = { status: "missing-entry" };
        return;
      }
      const fork = forkSqliteParentTranscriptInTransaction(writeDatabase, resolved, {
        parentEntry: freshParent,
        parentSessionKey: parentTarget.canonicalKey,
        targetSessionKey: sessionTarget.canonicalKey,
      });
      if (fork.status !== "created") {
        result =
          fork.status === "missing-parent" ? { status: "missing-parent" } : { status: "failed" };
        return;
      }
      const patch = params.patch?.({
        decision,
        entry: cloneSessionEntry(freshBase),
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
      });
      const next = mergeSessionEntry(freshBase, {
        ...patch,
        forkSource: {
          sessionKey: parentTarget.canonicalKey,
          sessionId: freshParent.sessionId,
        },
        forkedFromParent: true,
        sessionFile: fork.transcript.sessionFile,
        sessionId: fork.transcript.sessionId,
      });
      previousIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, sessionTarget.storeKeys);
      writeSessionEntry(writeDatabase, sessionTarget.canonicalKey, next, {
        previousEntry: freshBase,
      });
      rehomeSqliteSessionWindows(
        writeDatabase,
        sessionTarget.canonicalKey,
        sessionTarget.storeKeys,
      );
      deleteLegacySessionEntryRows(
        writeDatabase,
        sessionTarget.storeKeys,
        sessionTarget.canonicalKey,
        { rehomeMembers: freshBase.sessionId === next.sessionId },
      );
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: sessionTarget.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          skipMaintenance: true,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, sessionTarget.storeKeys);
      result = {
        status: "forked",
        decision,
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
        sessionEntry: cloneSessionEntry(next),
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

async function persistSqliteParentForkSkipPatch(params: {
  entry: SessionEntry;
  params: ForkSessionEntryFromParentTargetParams;
  sessionTarget: { canonicalKey: string; storeKeys: string[] };
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): Promise<SessionEntry> {
  if (!params.patch) {
    return cloneSessionEntry(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionTarget.canonicalKey,
  });
  const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
  let previousIdentity = new Map<string, SessionEntry>();
  let currentIdentity = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    previousIdentity = readSqliteSessionIdentitySnapshot(database, params.sessionTarget.storeKeys);
    writeSessionEntry(database, params.sessionTarget.canonicalKey, next, {
      previousEntry: params.entry,
    });
    rehomeSqliteSessionWindows(
      database,
      params.sessionTarget.canonicalKey,
      params.sessionTarget.storeKeys,
    );
    deleteLegacySessionEntryRows(
      database,
      params.sessionTarget.storeKeys,
      params.sessionTarget.canonicalKey,
      { rehomeMembers: params.entry.sessionId === next.sessionId },
    );
    maintenancePlans.push(
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: params.sessionTarget.canonicalKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(params.resolved),
        skipMaintenance: true,
      }),
    );
    currentIdentity = readSqliteSessionIdentitySnapshot(database, params.sessionTarget.storeKeys);
  }, toDatabaseOptions(params.resolved));
  emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
  finalizeSqliteSessionEntryMaintenancePlansBestEffort(params.resolved, maintenancePlans);
  return cloneSessionEntry(next);
}

/** Cleans scoped session lifecycle rows and associated SQLite transcript state. */

export async function resolveSqliteSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  const needsTranscriptTokenEstimate =
    typeof resolveFreshSessionTotalTokens(params.parentEntry) !== "number" &&
    parentSessionId.length > 0;
  if (!needsTranscriptTokenEstimate) {
    return resolveSqliteParentForkDecision(params.parentEntry);
  }
  const resolved = resolveSqliteStoreScope(params.storePath);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return resolveSqliteParentForkDecision(
    params.parentEntry,
    estimateSqliteTranscriptPromptTokens(
      loadSqliteTranscriptEventsFromDatabase(database, parentSessionId),
    ),
  );
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    parentEntry: SessionEntry;
    parentSessionKey: string;
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source = resolveSqliteParentForkSourceTranscript(
    loadSqliteTranscriptEventsFromDatabase(database, params.parentEntry.sessionId),
  );
  if (!source) {
    return { status: "failed" };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
  writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
    parentSessionFile,
    source,
  });
  return {
    status: "created",
    transcript: {
      sessionFile,
      sessionId,
    },
  };
}

function writeSqliteForkedChildTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: SqliteParentForkSourceTranscript;
  },
): void {
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildSqliteForkedChildTranscriptEvents({
      parentSessionFile: params.parentSessionFile,
      source: params.source,
      targetSessionId: targetScope.sessionId,
    }),
  );
}
