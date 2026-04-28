import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import {
  getSkillsSnapshotVersion,
  shouldRefreshSnapshotForVersion,
} from "../../agents/skills/refresh-state.js";
import { ensureSkillsWatcher } from "../../agents/skills/refresh.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveStableSessionEndTranscript } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
export { drainFormattedSystemEvents } from "./session-system-events.js";

async function persistSessionEntryUpdate(params: {
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  nextEntry: SessionEntry;
}) {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  params.sessionStore[params.sessionKey] = {
    ...params.sessionStore[params.sessionKey],
    ...params.nextEntry,
  };
  if (!params.storePath) {
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    store[params.sessionKey!] = { ...store[params.sessionKey!], ...params.nextEntry };
  });
}

function emitCompactionSessionLifecycleHooks(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  previousEntry: SessionEntry;
  nextEntry: SessionEntry;
}) {
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
    void hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
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
    void hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
      logVerbose(`session_start hook failed: ${String(err)}`);
    });
  }
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  cfg: OpenClawConfig;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
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
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
  } = params;

  let nextEntry = sessionEntry;
  let systemSent = sessionEntry?.systemSent ?? false;
  const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const remoteEligibility = getRemoteSkillEligibility({
    advertiseExecNode: canExecRequestNode({
      cfg,
      sessionEntry,
      sessionKey,
      agentId: sessionAgentId,
    }),
  });
  const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  const existingSnapshot = nextEntry?.skillsSnapshot;
  ensureSkillsWatcher({ workspaceDir, config: cfg });
  const shouldRefreshSnapshot =
    shouldRefreshSnapshotForVersion(existingSnapshot?.version, snapshotVersion) ||
    !matchesSkillFilter(existingSnapshot?.skillFilter, skillFilter);
  const buildSnapshot = () =>
    buildWorkspaceSkillSnapshot(workspaceDir, {
      config: cfg,
      agentId: sessionAgentId,
      skillFilter,
      eligibility: { remote: remoteEligibility },
      snapshotVersion,
    });

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot ? buildSnapshot() : current.skillsSnapshot;
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
    systemSent = true;
  }

  const hasFreshSnapshotInEntry =
    Boolean(nextEntry?.skillsSnapshot) &&
    (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot);
  const skillsSnapshot = hasFreshSnapshotInEntry
    ? nextEntry?.skillsSnapshot
    : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot
      ? buildSnapshot()
      : nextEntry.skillsSnapshot;
  if (
    skillsSnapshot &&
    sessionStore &&
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
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

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
  } else if (sessionFileChanged && explicitNewSessionFile) {
    updates.sessionFile = explicitNewSessionFile;
  }
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  const tokensAfterCompaction = resolvePositiveTokenCount(tokensAfter);
  if (tokensAfterCompaction !== undefined) {
    updates.totalTokens = tokensAfterCompaction;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  }
  sessionStore[sessionKey] = {
    ...entry,
    ...updates,
  };
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        ...store[sessionKey],
        ...updates,
      };
    });
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

function resolveCompactionSessionFile(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  newSessionId: string;
}): string {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const pathOpts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
    sessionFile: params.entry.sessionFile,
    previousSessionId: params.entry.sessionId,
    nextSessionId: params.newSessionId,
  });
  const normalizedRewrittenSessionFile =
    rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile)
      ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile)
      : rewrittenSessionFile;
  return resolveSessionFilePath(
    params.newSessionId,
    normalizedRewrittenSessionFile ? { sessionFile: normalizedRewrittenSessionFile } : undefined,
    pathOpts,
  );
}

function canonicalizeAbsoluteSessionFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const missingSegments: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync(cursor), ...missingSegments.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function rewriteSessionFileForNewSessionId(params: {
  sessionFile?: string;
  previousSessionId: string;
  nextSessionId: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionFile);
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".jsonl".length);
  if (withoutExt === params.previousSessionId) {
    return path.join(path.dirname(trimmed), `${params.nextSessionId}.jsonl`);
  }
  if (withoutExt.startsWith(`${params.previousSessionId}-topic-`)) {
    return path.join(
      path.dirname(trimmed),
      `${params.nextSessionId}${base.slice(params.previousSessionId.length)}`,
    );
  }
  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/,
  );
  if (forkMatch?.[2] === params.previousSessionId) {
    return path.join(path.dirname(trimmed), `${forkMatch[1]}_${params.nextSessionId}.jsonl`);
  }
  return undefined;
}
