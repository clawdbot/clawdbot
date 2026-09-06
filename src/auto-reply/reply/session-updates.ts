/** Session update helpers for skill snapshots and completed compaction accounting. */
import crypto from "node:crypto";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import {
  type ExecPolicyOverrides,
  resolveNodeExecEligibility,
} from "../../agents/exec-defaults.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  patchSessionEntryCore,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { projectCompactionAccountingPatch } from "../../config/sessions/session-entry-projection.js";
import { projectCanonicalSessionEntryShape } from "../../config/sessions/store-entry-shape.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";

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

/** Ensures a session entry has the reusable skill snapshot needed for reply runs. */
export async function ensureSkillSnapshot(params: {
  agentId: string;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  executionSkillsDir?: string;
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
    agentId,
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
  const nodeSkillsEligibility = resolveNodeExecEligibility({
    cfg,
    sessionEntry,
    sessionKey,
    agentId,
    execOverrides: params.execOverrides,
  });
  const remoteEligibility = getRemoteSkillEligibility({
    advertiseExecNode: nodeSkillsEligibility.canExec,
  });
  const existingSnapshot = nextEntry?.skillsSnapshot;
  const resolveSnapshot = (snapshot: SessionEntry["skillsSnapshot"]) =>
    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      ...(params.executionSkillsDir ? { executionSkillsDir: params.executionSkillsDir } : {}),
      config: cfg,
      agentId,
      skillFilter,
      skillOverrides,
      eligibility: { nodeSkills: nodeSkillsEligibility, remote: remoteEligibility },
      existingSnapshot: snapshot,
      librarySelections: nextEntry?.skillLibrarySelections,
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

/** Accounts completed compaction without creating or changing session ownership. */
export async function incrementCompactionCount(params: {
  agentId?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  now?: number;
  amount?: number;
  tokensAfter?: number;
  compactionKind?: EmbeddedAgentCompactResult["compactionKind"];
  expectedSession?: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId"
  >;
  transcriptByteCompactionLatch?: NonNullable<
    InternalSessionEntry["transcriptByteCompactionLatch"]
  >;
  authorize?: () => boolean;
}): Promise<number | undefined> {
  const { sessionStore, sessionKey, storePath, authorize } = params;
  if (!sessionKey || (!storePath && !sessionStore)) {
    return undefined;
  }
  const cachedEntry = sessionStore?.[sessionKey] ?? params.sessionEntry;
  const initial: typeof params.expectedSession = params.expectedSession ?? cachedEntry;
  if (!initial) {
    return undefined;
  }
  const expected = {
    sessionId: initial.sessionId,
    lifecycleRevision: initial.lifecycleRevision,
    activeWriterRunId: initial.activeWriterRunId,
  };
  const update = (current: InternalSessionEntry): Partial<InternalSessionEntry> | null => {
    if (
      !(authorize?.() ?? true) ||
      current.sessionId !== expected.sessionId ||
      current.lifecycleRevision !== expected.lifecycleRevision ||
      current.activeWriterRunId !== expected.activeWriterRunId
    ) {
      return null;
    }
    // The writer-serialized row owns the count, not the caller's pre-await cache.
    return projectCompactionAccountingPatch(current, params);
  };
  if (storePath) {
    let committed = false;
    const authorityRevoked = new Error("compaction accounting authority revoked");
    let persisted: InternalSessionEntry | null;
    try {
      persisted = await patchSessionEntryCore(
        { agentId: params.agentId, storePath, sessionKey },
        update,
        {
          onCommitted: (entry) => {
            committed = true;
            // Publish while this commit owns the row, before maintenance yields to a new writer.
            if (sessionStore) {
              sessionStore[sessionKey] = entry;
            }
          },
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
    if (!committed || !persisted) {
      return undefined;
    }
    return persisted.compactionCount;
  }
  const patch = cachedEntry && update(cachedEntry);
  if (!sessionStore || !cachedEntry || !patch) {
    return undefined;
  }
  const nextEntry = projectCanonicalSessionEntryShape({ ...cachedEntry, ...patch });
  sessionStore[sessionKey] = nextEntry;
  return nextEntry.compactionCount;
}
