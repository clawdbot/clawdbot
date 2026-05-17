import crypto from "node:crypto";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillSnapshot, type SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import {
  getSkillsSnapshotVersion,
  shouldRefreshSnapshotForVersion,
} from "../../agents/skills/refresh-state.js";
import { ensureSkillsWatcher } from "../../agents/skills/refresh.js";
import { hydrateResolvedSkills } from "../../agents/skills/snapshot-hydration.js";
import { stableStringify } from "../../agents/stable-stringify.js";
import {
  canonicalizeAbsoluteSessionFilePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  rewriteSessionFileForNewSessionId,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { resolveStableSessionEndTranscript } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
export { drainFormattedSystemEvents } from "./session-system-events.js";

// Warm-start resolvedSkills cache: avoids redundant buildSnapshot calls when
// stripPersistedSkillsCache has removed resolvedSkills between turns.
// Bounded to 10 entries to prevent unbounded growth in long-lived gateways.
const resolvedSkillsCache = new Map<string, SkillSnapshot["resolvedSkills"]>();
const RESOLVED_SKILLS_CACHE_MAX = 10;

export function __testing_resetResolvedSkillsCache(): void {
  resolvedSkillsCache.clear();
}

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("clientsecret")
  );
}

function redactSensitiveConfigValue(value: unknown): unknown {
  if (value === undefined || value === null || value === false || value === "") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim() ? "[redacted:string]" : "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0 ? "[redacted:number]" : value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : "[redacted:array]";
  }
  return "[redacted:object]";
}

function redactConfigForSkillSnapshotCache(value: unknown, stack = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (stack.has(value)) {
    return "[Circular]";
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactConfigForSkillSnapshotCache(entry, stack));
    }
    const redacted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const field = (value as Record<string, unknown>)[key];
      redacted[key] = isSensitiveConfigKey(key)
        ? redactSensitiveConfigValue(field)
        : redactConfigForSkillSnapshotCache(field, stack);
    }
    return redacted;
  } finally {
    stack.delete(value);
  }
}

// Skill frontmatter `requires.config` reads the full OpenClaw config, so cache
// reuse must follow the same boundary without putting raw secrets in Map keys.
function fingerprintSkillSnapshotConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(redactConfigForSkillSnapshotCache(config)))
    .digest("hex");
}

function cacheResolvedSkills(cacheKey: string, snapshot: SkillSnapshot): SkillSnapshot {
  resolvedSkillsCache.set(cacheKey, snapshot.resolvedSkills);
  if (resolvedSkillsCache.size > RESOLVED_SKILLS_CACHE_MAX) {
    const oldest = resolvedSkillsCache.keys().next().value;
    if (oldest !== undefined) {
      resolvedSkillsCache.delete(oldest);
    }
  }
  return snapshot;
}

// nextEntry.skillsSnapshot may carry resolvedSkills (full Skill[] with
// SKILL.md bodies) for in-turn use. The persistence layer in
// src/config/sessions/store-load.ts strips resolvedSkills before serializing,
// so the on-disk sessions.json stays small. The in-memory params.sessionStore
// reference still carries the runtime cache for the rest of this turn.
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
  const buildSnapshot = () => {
    return buildWorkspaceSkillSnapshot(workspaceDir, {
      config: cfg,
      agentId: sessionAgentId,
      skillFilter,
      eligibility: { remote: remoteEligibility },
      snapshotVersion,
    });
  };

  const configFingerprint = fingerprintSkillSnapshotConfig(cfg);
  const snapshotCacheKey = JSON.stringify([
    workspaceDir,
    snapshotVersion,
    skillFilter,
    sessionAgentId,
    remoteEligibility,
    configFingerprint,
  ]);

  const cachedRebuild = (): SkillSnapshot => {
    if (resolvedSkillsCache.has(snapshotCacheKey)) {
      return { resolvedSkills: resolvedSkillsCache.get(snapshotCacheKey) } as SkillSnapshot;
    }
    return cacheResolvedSkills(snapshotCacheKey, buildSnapshot());
  };

  const buildAndCache = (): SkillSnapshot => cacheResolvedSkills(snapshotCacheKey, buildSnapshot());

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot
        ? buildAndCache()
        : hydrateResolvedSkills(current.skillsSnapshot, cachedRebuild);
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
  const skillsSnapshot =
    hasFreshSnapshotInEntry && nextEntry?.skillsSnapshot
      ? hydrateResolvedSkills(nextEntry.skillsSnapshot, cachedRebuild)
      : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot
        ? buildAndCache()
        : hydrateResolvedSkills(nextEntry.skillsSnapshot, cachedRebuild);
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
    updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    updates.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
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
  } else if (incrementBy > 0) {
    updates.totalTokensFresh = false;
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
