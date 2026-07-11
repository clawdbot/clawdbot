// Narrow session-store helpers for channel hot paths.

import path from "node:path";
import {
  readAmbientTranscriptWatermark as readAmbientTranscriptWatermarkFromEntry,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  type AmbientTranscriptWatermarkScope,
} from "../config/sessions/ambient-transcript-watermark.js";
import { resolveStorePath as resolveSessionStorePath } from "../config/sessions/paths.js";
import {
  cleanupSessionLifecycleArtifacts as cleanupAccessorSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle as deleteAccessorSessionEntryLifecycle,
  loadTranscriptEventsSync as loadAccessorTranscriptEventsSync,
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  patchSessionEntry as patchAccessorSessionEntry,
  readSessionUpdatedAt as readAccessorSessionUpdatedAt,
  readTranscriptStatsSync as readAccessorTranscriptStatsSync,
  replaceSessionEntry,
  resolveTranscriptSessionKeyBySessionId as resolveAccessorTranscriptSessionKeyBySessionId,
  type SessionAccessScope,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { normalizeResolvedMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../config/sessions/store.js";
import type { AmbientTranscriptWatermark, SessionEntry } from "../config/sessions/types.js";
import type { SessionTranscriptEvent } from "./session-transcript-runtime.js";

const SQLITE_SESSION_STORE_BACKUP_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

type SessionStoreListParams = Partial<Omit<SessionStoreReadParams, "sessionKey">>;

type SessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

export type SessionStoreTranscriptEvent = SessionTranscriptEvent;

type SessionStoreEntryUpdate = (
  entry: SessionEntry,
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type SessionStoreEntryPatch = (
  entry: SessionEntry,
  context: { existingEntry?: SessionEntry },
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type PatchSessionEntryParams = SessionStoreReadParams & {
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  requireWriteSuccess?: boolean;
  replaceEntry?: boolean;
  skipMaintenance?: boolean;
  update: SessionStoreEntryPatch;
};

type ReadAmbientTranscriptWatermarkParams = SessionStoreReadParams & {
  key: string;
};

type UpdateSessionStoreEntryParams = {
  storePath: string;
  sessionKey: string;
  update: SessionStoreEntryUpdate;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type UpsertSessionEntryParams = SessionStoreReadParams & {
  entry: SessionEntry;
};

type DeleteSessionEntryParams = SessionStoreReadParams & {
  archiveTranscript?: boolean;
};

type SessionLifecycleArtifactsCleanupParams = {
  agentId?: string;
  archiveRemovedEntryTranscripts?: boolean;
  env?: NodeJS.ProcessEnv;
  orphanTranscriptMinAgeMs: number;
  sessionStore?: string;
  sessionKeySegmentPrefix: string;
  storePath?: string;
  transcriptContentMarker: string;
  nowMs?: number;
};

type SessionLifecycleArtifactsCleanupResult = {
  archivedTranscriptArtifacts: number;
  removedEntries: number;
};

function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Maintainer note: keep this adapter narrow so plugin callers retain the
  // object-parameter API while internal accessor-only options stay private.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

/** Loads one session entry by agent/session identity. */
export function getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntry(toSessionAccessScope(params));
}

/** Lists session entries for one agent. */
export function listSessionEntries(
  params: SessionStoreListParams = {},
): SessionStoreEntrySummary[] {
  return listAccessorSessionEntries({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
}

/** Reads transcript events for a live SQLite-backed session identity. */
export function loadTranscriptEventsSync(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): SessionStoreTranscriptEvent[] {
  return loadAccessorTranscriptEventsSync(params);
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsSync(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): { eventCount: number; maxSeq: number; sizeBytes: number } {
  return readAccessorTranscriptStatsSync(params);
}

/** Resolves the persisted session key for one SQLite transcript identity. */
export function resolveTranscriptSessionKeyBySessionId(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  storePath?: string;
}): string | undefined {
  return resolveAccessorTranscriptSessionKeyBySessionId(params);
}

/** Patches one session entry by agent/session identity. */
export async function patchSessionEntry(
  params: PatchSessionEntryParams,
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig:
      params.maintenanceConfig !== undefined
        ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
        : undefined,
    preserveActivity: params.preserveActivity,
    requireWriteSuccess: params.requireWriteSuccess,
    replaceEntry: params.replaceEntry,
    skipMaintenance: params.skipMaintenance,
  });
}

/** Reads the last activity timestamp for one session entry. */
export function readSessionUpdatedAt(params: SessionStoreReadParams): number | undefined {
  return readAccessorSessionUpdatedAt(toSessionAccessScope(params));
}

export { resolveAmbientTranscriptWatermarkKey, updateAmbientTranscriptWatermark };
export type { AmbientTranscriptWatermarkScope };

export function readAmbientTranscriptWatermark(
  params: ReadAmbientTranscriptWatermarkParams,
): AmbientTranscriptWatermark | undefined {
  return readAmbientTranscriptWatermarkFromEntry(getSessionEntry(params), params.key);
}

/** Updates an existing session entry by store path and session key. */
export async function updateSessionStoreEntry(
  params: UpdateSessionStoreEntryParams,
): Promise<SessionEntry | null> {
  return await updateSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
}

/** Replaces or creates one session entry by agent/session identity. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

/** Deletes one session entry by agent/session identity. */
export async function deleteSessionEntry(params: DeleteSessionEntryParams): Promise<boolean> {
  const storePath =
    params.storePath ??
    resolveSessionStorePath(undefined, {
      agentId: params.agentId,
      env: params.env,
    });
  const result = await deleteAccessorSessionEntryLifecycle({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    archiveTranscript: params.archiveTranscript ?? false,
    storePath,
    target: {
      canonicalKey: params.sessionKey,
      storeKeys: [params.sessionKey],
    },
  });
  return result.deleted;
}

/** Resolves the file artifacts that should be backed up before mutating a session store. */
export function resolveSessionStoreBackupPaths(params: {
  agentId?: string;
  storePath: string;
}): string[] {
  const backupPaths = new Set<string>();
  backupPaths.add(path.resolve(params.storePath));

  const sqlitePath = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.agentId,
  }).path;
  if (sqlitePath) {
    for (const suffix of SQLITE_SESSION_STORE_BACKUP_SUFFIXES) {
      backupPaths.add(`${sqlitePath}${suffix}`);
    }
  }

  return [...backupPaths];
}

/** Cleans stale lifecycle-owned session entries and orphan transcripts for one agent store. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactsCleanupParams,
): Promise<SessionLifecycleArtifactsCleanupResult> {
  const storePath =
    params.storePath ??
    resolveSessionStorePath(params.sessionStore, {
      agentId: params.agentId,
      env: params.env,
    });
  return await cleanupAccessorSessionLifecycleArtifacts({
    storePath,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
    sessionKeySegmentPrefix: params.sessionKeySegmentPrefix,
    transcriptContentMarker: params.transcriptContentMarker,
    orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
    nowMs: params.nowMs,
  });
}

export { resolveStorePath } from "../config/sessions/paths.js";
export {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesSession,
  type SqliteSessionFileMarker,
} from "../config/sessions/sqlite-marker.js";
export {
  readRecentUserAssistantTextForSession,
  type SessionRecentConversationText,
} from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
export { isValidAgentHarnessSessionStoreEntry } from "../sessions/agent-harness-session-key.js";
// SDK-facing names are a shipped plugin contract; internals route through the
// session accessor so the storage backend can change beneath them.
export {
  recordInboundSessionMeta as recordSessionMetaFromInbound,
  updateSessionLastRoute as updateLastRoute,
} from "../config/sessions/session-accessor.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSendPolicy } from "../sessions/send-policy.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
