/** Session update helpers for skill snapshots, compaction, and lifecycle hooks. */
import crypto from "node:crypto";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import {
  type ExecPolicyOverrides,
  resolveNodeExecEligibility,
} from "../../agents/exec-defaults.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  patchSessionEntryCore,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { projectCanonicalSessionEntryShape } from "../../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { resolveStableSessionEndTranscript } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

async function persistSessionEntryUpdate(params: {
  expectedSessionId: string | undefined;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  nextEntry: SessionEntry;
  updates: Partial<SessionEntry>;
}): Promise<SessionEntry | undefined> {
  if (!params.sessionEntryHandle && (!params.sessionStore || !params.sessionKey)) {
    return undefined;
  }
  if (!params.storePath || !params.sessionKey) {
    if (params.sessionEntryHandle) {
      params.sessionEntryHandle.replaceCurrent(params.nextEntry);
    } else if (params.sessionStore && params.sessionKey) {
      params.sessionStore[params.sessionKey] = {
        ...params.sessionStore[params.sessionKey],
        ...params.nextEntry,
      };
    }
    return params.nextEntry;
  }
  const persistedEntry = await updateSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    (entry) => (entry.sessionId === params.expectedSessionId ? params.updates : null),
  );
  if (persistedEntry) {
    if (params.sessionEntryHandle) {
      params.sessionEntryHandle.replaceCurrent(persistedEntry);
    } else if (params.sessionStore && params.sessionKey) {
      params.sessionStore[params.sessionKey] = persistedEntry;
    }
    return persistedEntry;
  }
  params.sessionEntryHandle?.clearCurrent();
  if (params.sessionStore && params.sessionKey) {
    delete params.sessionStore[params.sessionKey];
  }
  return undefined;
}

function emitCompactionSessionLifecycleHooks(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  previousEntry: SessionEntry;
  nextEntry: SessionEntry;
}) {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (params.previousEntry.sessionId) {
    forgetActiveSessionForShutdown(params.previousEntry.sessionId);
  }
  if (params.nextEntry.sessionId && params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.nextEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionKey,
      agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }

  if (hookRunner.hasHooks("session_end")) {
    const storePath =
      agentId && params.storePath
        ? resolveSessionStorePathForScope({
            agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : params.storePath;
    const transcript = resolveStableSessionEndTranscript({
      sessionId: params.previousEntry.sessionId,
      storePath,
      agentId,
    });
    const payload = buildSessionEndHookPayload({
      sessionId: params.previousEntry.sessionId,
      sessionKey: params.sessionKey,
      agentId,
      reason: "compaction",
      sessionFile:
        transcript.sessionFile ??
        (agentId && storePath
          ? formatSqliteSessionFileMarker({
              agentId,
              sessionId: params.previousEntry.sessionId,
              storePath,
            })
          : undefined),
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextEntry.sessionId,
    });
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await hookRunner.runSessionEnd(payload.event, payload.context);
    }).catch((err: unknown) => {
      logVerbose(`session_end hook failed: ${String(err)}`);
    });
  }

  if (hookRunner.hasHooks("session_start")) {
    const payload = buildSessionStartHookPayload({
      sessionId: params.nextEntry.sessionId,
      sessionKey: params.sessionKey,
      agentId,
      resumedFrom: params.previousEntry.sessionId,
    });
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await hookRunner.runSessionStart(payload.event, payload.context);
    }).catch((err: unknown) => {
      logVerbose(`session_start hook failed: ${String(err)}`);
    });
  }
}

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Ensures a session entry has the reusable skill snapshot needed for reply runs. */
export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  cfg: OpenClawConfig;
  execOverrides?: ExecPolicyOverrides;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (isFastTestRuntimeEnv()) {
    // In fast unit-test runs we skip filesystem scanning, watchers, and session-store writes.
    // Dedicated skills tests cover snapshot generation behavior.
    return {
      sessionEntry: params.sessionEntry,
      skillsSnapshot: params.sessionEntry?.skillsSnapshot,
      systemSent: params.sessionEntry?.systemSent ?? false,
    };
  }

  const {
    sessionEntry,
    sessionEntryHandle,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
    skillOverrides,
  } = params;

  let nextEntry = sessionEntryHandle?.getCurrent() ?? sessionEntry;
  let systemSent = sessionEntry?.systemSent ?? false;
  const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const nodeSkillsEligibility = resolveNodeExecEligibility({
    cfg,
    sessionEntry,
    sessionKey,
    agentId: sessionAgentId,
    execOverrides: params.execOverrides,
  });
  const remoteEligibility = getRemoteSkillEligibility({
    advertiseExecNode: nodeSkillsEligibility.canExec,
  });
  const existingSnapshot = nextEntry?.skillsSnapshot;
  const resolveSnapshot = (snapshot: SessionEntry["skillsSnapshot"]) =>
    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: cfg,
      agentId: sessionAgentId,
      skillFilter,
      skillOverrides,
      eligibility: { nodeSkills: nodeSkillsEligibility, remote: remoteEligibility },
      existingSnapshot: snapshot,
    });
  const initialSnapshotState = resolveSnapshot(existingSnapshot);
  const shouldRefreshSnapshot = initialSnapshotState.shouldRefresh;

  if (isFirstTurnInSession && (sessionEntryHandle || sessionStore) && sessionKey) {
    const current = nextEntry ??
      sessionEntryHandle?.get(sessionKey) ??
      sessionStore?.[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot
        ? initialSnapshotState.snapshot
        : resolveSnapshot(current.skillsSnapshot).snapshot;
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    const persistedEntry = await persistSessionEntryUpdate({
      expectedSessionId: current.sessionId,
      sessionEntryHandle,
      sessionStore,
      sessionKey,
      storePath,
      nextEntry,
      updates: {
        sessionId: nextEntry.sessionId,
        updatedAt: nextEntry.updatedAt,
        systemSent: nextEntry.systemSent,
        skillsSnapshot: nextEntry.skillsSnapshot,
      },
    });
    nextEntry = persistedEntry;
    systemSent = persistedEntry?.systemSent ?? systemSent;
  }

  const hasFreshSnapshotInEntry =
    Boolean(nextEntry?.skillsSnapshot) &&
    (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot);
  const skillsSnapshot =
    hasFreshSnapshotInEntry && nextEntry?.skillsSnapshot
      ? resolveSnapshot(nextEntry.skillsSnapshot).snapshot
      : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot
        ? initialSnapshotState.snapshot
        : resolveSnapshot(nextEntry.skillsSnapshot).snapshot;
  if (
    skillsSnapshot &&
    (sessionEntryHandle || sessionStore) &&
    sessionKey &&
    !isFirstTurnInSession &&
    (!nextEntry?.skillsSnapshot || shouldRefreshSnapshot)
  ) {
    const current = nextEntry ?? {
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    nextEntry = await persistSessionEntryUpdate({
      expectedSessionId: current.sessionId,
      sessionEntryHandle,
      sessionStore,
      sessionKey,
      storePath,
      nextEntry,
      updates: {
        sessionId: nextEntry.sessionId,
        updatedAt: nextEntry.updatedAt,
        skillsSnapshot: nextEntry.skillsSnapshot,
      },
    });
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

/** Increments compaction count and persists the updated session entry. */
export async function incrementCompactionCount(params: {
  agentId?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  cfg?: OpenClawConfig;
  now?: number;
  amount?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
  /** Session id after compaction when a context engine changed identity. */
  newSessionId?: string;
  compactionKind?: EmbeddedAgentCompactResult["compactionKind"];
  expectedSession?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  authorize?: () => boolean;
}): Promise<number | undefined> {
  const {
    agentId,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    cfg,
    now = Date.now(),
    amount = 1,
    tokensAfter,
    newSessionId,
    compactionKind,
    expectedSession,
    authorize,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }
  const canApply = (current: SessionEntry) =>
    (authorize?.() ?? true) &&
    (!expectedSession ||
      (current.sessionId === expectedSession.sessionId &&
        current.lifecycleRevision === expectedSession.lifecycleRevision));
  if (!canApply(entry)) {
    return undefined;
  }
  const incrementBy = Math.max(0, amount);
  const nextCount = (entry.compactionCount ?? 0) + incrementBy;
  const updates: Partial<SessionEntry> = {
    compactionCount: nextCount,
    updatedAt: now,
  };
  if (compactionKind === "context-engine") {
    clearAllCliSessions(updates);
  }
  const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
  if (sessionIdChanged && newSessionId) {
    updates.sessionId = newSessionId;
    updates.restartRecoveryOwner = undefined;
    updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    updates.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
  }
  const tokensAfterCompaction = resolveNonNegativeTokenCount(tokensAfter);
  if (tokensAfterCompaction !== undefined) {
    updates.totalTokens = tokensAfterCompaction;
    updates.totalTokensFresh = true;
    updates.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  } else if (incrementBy > 0) {
    updates.totalTokensFresh = false;
    updates.totalTokensVersion = undefined;
  }
  const nextEntry = projectCanonicalSessionEntryShape({ ...entry, ...updates });
  const effectiveStorePath = storePath
    ? resolveSessionStorePathForScope({ agentId, sessionKey, storePath })
    : undefined;
  if (effectiveStorePath) {
    let committed = false;
    const authorityRevoked = new Error("compaction accounting authority revoked");
    let persistedEntry: SessionEntry | null;
    try {
      persistedEntry = await patchSessionEntryCore(
        { ...(agentId ? { agentId } : {}), storePath: effectiveStorePath, sessionKey },
        (current) => {
          if (!canApply(current)) {
            return null;
          }
          committed = true;
          return updates;
        },
        {
          ...(expectedSession ? {} : { fallbackEntry: nextEntry }),
          ...(authorize
            ? {
                assertCommitAllowed: () => {
                  if (!authorize()) {
                    throw authorityRevoked;
                  }
                },
              }
            : {}),
        },
      );
    } catch (error) {
      if (error === authorityRevoked) {
        return undefined;
      }
      throw error;
    }
    if (!committed || !persistedEntry) {
      return undefined;
    }
    sessionStore[sessionKey] = persistedEntry;
  } else {
    sessionStore[sessionKey] = nextEntry;
  }
  if (sessionIdChanged && cfg) {
    emitCompactionSessionLifecycleHooks({
      agentId,
      cfg,
      sessionKey,
      storePath: effectiveStorePath,
      previousEntry: entry,
      nextEntry: sessionStore[sessionKey],
    });
  }
  return nextCount;
}
