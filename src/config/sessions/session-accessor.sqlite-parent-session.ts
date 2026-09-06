import { randomUUID } from "node:crypto";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";
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
  normalizeLifecycleTarget,
  readSessionIdentitySnapshot,
  resolveLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  buildForkedChildTranscriptEvents,
  estimateTranscriptPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  formatLegacySqliteSessionMarkerForScope,
  formatSqliteSessionReferenceForScope,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry, resolveFreshSessionTotalTokens } from "./types.js";

// Parent-session fork owner: decision, transcript copy, and child entry commit.

export async function forkSessionTranscriptFromParent(
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
        params.commitGuard?.();
        result = forkSqliteParentTranscriptInTransaction(database, resolved, {
          enforceTokenLimit: params.enforceTokenLimit,
          maxTokens: params.maxTokens,
          parentEntry: params.parentEntry,
          parentSessionKey: params.parentSessionKey,
          forkFrom: params.forkFrom,
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
  // exclusive target-database writer queue.
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(sourceDatabase, params.parentEntry.sessionId),
    params.forkFrom,
  );
  if (!source) {
    return { status: "failed" };
  }
  const limitDecision = resolveParentForkLimitDecision(params, source);
  if (limitDecision) {
    return { status: "too-large", decision: limitDecision };
  }
  const parentSessionFile = formatLegacySqliteSessionMarkerForScope({
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
    const sessionFile = formatSqliteSessionReferenceForScope(targetScope);
    runOpenClawAgentWriteTransaction((database) => {
      params.commitGuard?.();
      writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
        parentSessionFile,
        source,
      });
    }, toDatabaseOptions(target));
    return { status: "created", transcript: { sessionFile, sessionId } };
  });
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  return await runExclusiveSqliteSessionWrite<ForkSessionEntryFromParentTargetResult>(
    resolved,
    async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const parent = resolveLifecyclePrimaryEntry(database, parentTarget);
      if (!parent?.entry.sessionId) {
        return { status: "missing-parent" };
      }

      const existing = resolveLifecyclePrimaryEntry(database, sessionTarget);
      const base = existing?.entry ?? params.fallbackEntry;
      if (!base) {
        return { status: "missing-entry" };
      }

      if (params.skipForkWhen?.(cloneSessionEntry(base))) {
        const sessionEntry = persistSqliteParentForkSkipPatch({
          commitGuard: params.commitGuard,
          entry: base,
          sessionKey: sessionTarget.canonicalKey,
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

      assertModelSelectionUnlocked(parent.entry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
      const needsTranscriptTokenEstimate =
        typeof resolveFreshSessionTotalTokens(parent.entry) !== "number" &&
        typeof parent.entry.sessionId === "string" &&
        parent.entry.sessionId.length > 0;
      const transcriptParentTokens = needsTranscriptTokenEstimate
        ? estimateTranscriptPromptTokens(
            loadTranscriptEventsFromDatabase(database, parent.entry.sessionId),
          )
        : undefined;
      const decision = planParentForkDecision(parent.entry, transcriptParentTokens);
      if (decision.status === "skip") {
        const patch = params.decisionSkipPatch?.({
          decision,
          entry: cloneSessionEntry(base),
          parentEntry: cloneSessionEntry(parent.entry),
        });
        const sessionEntry = persistSqliteParentForkSkipPatch({
          commitGuard: params.commitGuard,
          entry: base,
          sessionKey: sessionTarget.canonicalKey,
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
      let previousIdentity = new Map<string, SessionEntry>();
      let currentIdentity = new Map<string, SessionEntry>();
      runOpenClawAgentWriteTransaction((writeDatabase) => {
        // Parent authority can close while this fork waits behind another writer.
        params.commitGuard?.();
        const freshParent = resolveLifecyclePrimaryEntry(writeDatabase, parentTarget)?.entry;
        if (!freshParent?.sessionId) {
          result = { status: "missing-parent" };
          return;
        }
        // The copied transcript belongs to this authoritative parent, not the
        // preflight snapshot; a harness lock may have changed while preparing.
        assertModelSelectionUnlocked(freshParent, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
        const freshExisting = resolveLifecyclePrimaryEntry(writeDatabase, sessionTarget);
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
        const forkIdentityPatch: Partial<InternalSessionEntry> = {
          ...patch,
          forkSource: {
            sessionKey: parentTarget.canonicalKey,
            sessionId: freshParent.sessionId,
          },
          forkedFromParent: true,
          lifecycleRunId: undefined,
          lastRunId: undefined,
          sessionId: fork.transcript.sessionId,
          totalTokens: undefined,
          totalTokensFresh: false,
          totalTokensVersion: undefined,
        };
        previousIdentity = readSessionIdentitySnapshot(writeDatabase, [sessionTarget.canonicalKey]);
        const next = writeSessionEntry(
          writeDatabase,
          sessionTarget.canonicalKey,
          mergeSessionEntry(freshBase, forkIdentityPatch),
          { previousEntry: freshBase },
        );
        currentIdentity = readSessionIdentitySnapshot(writeDatabase, [sessionTarget.canonicalKey]);
        result = {
          status: "forked",
          decision,
          fork: fork.transcript,
          parentEntry: cloneSessionEntry(freshParent),
          sessionEntry: cloneSessionEntry(next),
        };
      }, toDatabaseOptions(resolved));
      emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
      return result;
    },
  );
}

function persistSqliteParentForkSkipPatch(params: {
  commitGuard?: () => void;
  entry: SessionEntry;
  sessionKey: string;
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): SessionEntry {
  if (!params.patch) {
    return cloneSessionEntry(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionKey,
  });
  let previousIdentity = new Map<string, SessionEntry>();
  let currentIdentity = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    params.commitGuard?.();
    previousIdentity = readSessionIdentitySnapshot(database, [params.sessionKey]);
    writeSessionEntry(database, params.sessionKey, next, {
      previousEntry: params.entry,
    });
    currentIdentity = readSessionIdentitySnapshot(database, [params.sessionKey]);
  }, toDatabaseOptions(params.resolved));
  emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
  return cloneSessionEntry(next);
}

export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  const needsTranscriptTokenEstimate =
    typeof resolveFreshSessionTotalTokens(params.parentEntry) !== "number" &&
    parentSessionId.length > 0;
  if (!needsTranscriptTokenEstimate) {
    return planParentForkDecision(params.parentEntry);
  }
  const resolved = resolveSqliteStoreScope(params.storePath);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return planParentForkDecision(
    params.parentEntry,
    estimateTranscriptPromptTokens(loadTranscriptEventsFromDatabase(database, parentSessionId)),
  );
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    enforceTokenLimit?: boolean;
    maxTokens?: number;
    parentEntry: SessionEntry;
    parentSessionKey: string;
    forkFrom?: "last-completed";
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(database, params.parentEntry.sessionId),
    params.forkFrom,
  );
  if (!source) {
    return { status: "failed" };
  }
  const limitDecision = resolveParentForkLimitDecision(params, source);
  if (limitDecision) {
    return { status: "too-large", decision: limitDecision };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatLegacySqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteSessionReferenceForScope(targetScope);
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

function resolveParentForkLimitDecision(
  params: Pick<
    ForkSessionFromParentTranscriptParams,
    "enforceTokenLimit" | "forkFrom" | "maxTokens" | "parentEntry"
  >,
  source: ParentForkSourceTranscript,
): Extract<SessionParentForkDecision, { status: "skip" }> | undefined {
  if (!params.enforceTokenLimit) {
    return undefined;
  }
  const decision = planParentForkDecision(
    params.parentEntry,
    estimateTranscriptPromptTokens(source.branchEntries),
    {
      maxTokens: params.maxTokens,
      preferTranscriptEstimate: params.forkFrom === "last-completed",
    },
  );
  return decision.status === "skip" ? decision : undefined;
}

function writeSqliteForkedChildTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: ParentForkSourceTranscript;
  },
): void {
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildForkedChildTranscriptEvents({
      parentSessionFile: params.parentSessionFile,
      source: params.source,
      targetSessionId: targetScope.sessionId,
    }),
  );
}
