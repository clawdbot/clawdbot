/** Session update helpers for skill snapshots, compaction, and lifecycle hooks. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  type ExecPolicyOverrides,
  resolveNodeExecEligibility,
} from "../../agents/exec-defaults.js";
import { resolveCompactionSessionFile, type SessionEntry } from "../../config/sessions.js";
import { patchSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
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
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  previousEntry: SessionEntry;
  nextEntry: SessionEntry;
}) {
  if (params.previousEntry.sessionId) {
    forgetActiveSessionForShutdown(params.previousEntry.sessionId);
  }
  if (params.nextEntry.sessionId && params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.nextEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.nextEntry.sessionFile,
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }

  if (hookRunner.hasHooks("session_end")) {
    const transcript = resolveStableSessionEndTranscript({
      sessionId: params.previousEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.previousEntry.sessionFile,
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    });
    const payload = buildSessionEndHookPayload({
      sessionId: params.previousEntry.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      reason: "compaction",
      sessionFile: transcript.sessionFile,
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
      cfg: params.cfg,
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
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  cfg?: OpenClawConfig;
  now?: number;
  amount?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
  /** Session id after compaction, when the runtime rotated transcripts. */
  newSessionId?: string;
  /** Session file after compaction, when the runtime rotated transcripts. */
  newSessionFile?: string;
}): Promise<number | undefined> {
  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    cfg,
    now = Date.now(),
    amount = 1,
    tokensAfter,
    newSessionId,
    newSessionFile,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }
  const incrementBy = Math.max(0, amount);
  const nextCount = (entry.compactionCount ?? 0) + incrementBy;
  // Build update payload with compaction count and optionally updated token counts
  const updates: Partial<SessionEntry> = {
    compactionCount: nextCount,
    updatedAt: now,
  };
  const explicitNewSessionFile = normalizeOptionalString(newSessionFile);
  const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
  const sessionFileChanged = Boolean(
    explicitNewSessionFile && explicitNewSessionFile !== entry.sessionFile,
  );
  if (sessionIdChanged && newSessionId) {
    updates.sessionId = newSessionId;
    updates.sessionFile =
      explicitNewSessionFile ??
      resolveCompactionSessionFile({
        entry,
        sessionKey,
        storePath,
        newSessionId,
      });
    updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    updates.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
  } else if (sessionFileChanged && explicitNewSessionFile) {
    updates.sessionFile = explicitNewSessionFile;
  }
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  const tokensAfterCompaction = resolveNonNegativeTokenCount(tokensAfter);
  if (tokensAfterCompaction !== undefined) {
    updates.totalTokens = tokensAfterCompaction;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  } else if (incrementBy > 0) {
    updates.totalTokensFresh = false;
  }
  const nextEntry = {
    ...entry,
    ...updates,
  };
  sessionStore[sessionKey] = nextEntry;
  if (storePath) {
    const persistedEntry = await patchSessionEntry({ storePath, sessionKey }, () => updates, {
      fallbackEntry: nextEntry,
    });
    if (persistedEntry) {
      sessionStore[sessionKey] = persistedEntry;
    }
  }
  if ((sessionIdChanged || sessionFileChanged) && cfg) {
    emitCompactionSessionLifecycleHooks({
      cfg,
      sessionKey,
      storePath,
      previousEntry: entry,
      nextEntry: sessionStore[sessionKey],
    });
  }
  return nextCount;
}
