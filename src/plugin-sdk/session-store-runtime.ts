// Narrow session-store helpers for channel hot paths.

import fs from "node:fs";
import path from "node:path";
import {
  readAmbientTranscriptWatermark as readAmbientTranscriptWatermarkFromEntry,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
  type AmbientTranscriptWatermarkScope,
} from "../config/sessions/ambient-transcript-watermark.js";
import { resolveStorePath as resolveSessionStorePath } from "../config/sessions/paths.js";
import { resolveSessionFilePath as resolveLegacySessionFilePath } from "../config/sessions/paths.js";
import {
  applySessionStoreProjection as applyAccessorSessionStoreProjection,
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
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/sqlite-marker.js";
import { resolveSessionStoreEntry as resolveSessionStoreEntryFromStore } from "../config/sessions/store-entry.js";
import { normalizeResolvedMaintenanceConfigInput } from "../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../config/sessions/store.js";
import type { AmbientTranscriptWatermark, SessionEntry } from "../config/sessions/types.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { SessionTranscriptEvent } from "./session-transcript-runtime.js";

const SQLITE_SESSION_STORE_BACKUP_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES = 16 * 1024 * 1024;
// Beta.5 Codex resolves and loads synchronously; beta.5 Feishu dedupes targets
// by path before load/update. Last selection therefore matches every shipped
// caller. This map is not a general replacement for target-aware SDK methods.
const legacyStoreAgentIds = new Map<string, string>();

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

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  hydrateSkillPromptRefs?: boolean;
};

export type UpdateSessionStoreOptions<T> = {
  activeSessionKey?: string;
  skipMaintenance?: boolean;
  skipSaveWhenResult?: (result: T) => boolean;
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

function resolveLegacySessionStoreTarget(storePath: string): {
  agentId?: string;
  storePath: string;
} {
  const resolvedStorePath = path.resolve(storePath);
  const selectedAgentId = legacyStoreAgentIds.get(resolvedStorePath);
  const target = resolveSqliteTargetFromSessionStorePath(resolvedStorePath, {
    agentId: selectedAgentId,
  });
  const agentId = target.agentId ?? selectedAgentId;
  return {
    ...(agentId ? { agentId } : {}),
    storePath: target.path ?? resolvedStorePath,
  };
}

function materializeLegacyTranscriptFile(
  sessionFile: string,
  options?: { agentId?: string; sessionsDir?: string },
): string {
  const marker = parseSqliteSessionFileMarker(sessionFile);
  if (!marker) {
    return sessionFile;
  }
  const transcriptScope = {
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  } as const;
  const transcriptPath = resolveLegacySessionFilePath(marker.sessionId, undefined, {
    agentId: marker.agentId,
    ...(options?.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
  });
  const stats = readAccessorTranscriptStatsSync(transcriptScope);
  const serializedSize = stats.sizeBytes + (stats.eventCount > 0 ? 1 : 0);
  const isOversized = serializedSize > LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES;
  const content = isOversized
    ? ""
    : (() => {
        const events = loadAccessorTranscriptEventsSync(transcriptScope);
        return events.length > 0
          ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
          : "";
      })();
  replaceFileAtomicSync({
    filePath: transcriptPath,
    content,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: `${path.basename(transcriptPath)}.sqlite-compat`,
    copyFallbackOnPermissionError: true,
    syncParentDir: true,
    syncTempFile: true,
    ...(isOversized
      ? {
          beforeRename: ({ tempPath }: { tempPath: string }) => {
            // Beta.5 Feishu only stats oversized transcripts before skipping
            // inspection. SQLite remains canonical; this sparse sentinel is
            // never parsed and keeps compatibility materialization bounded.
            fs.truncateSync(tempPath, LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES + 1);
            const fd = fs.openSync(tempPath, "r+");
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          },
        }
      : {}),
  });
  return transcriptPath;
}

/**
 * @deprecated Use getSessionEntry or listSessionEntries.
 *
 * Official plugins released with v2026.7.1-beta.5 import this symbol. Keep the
 * compatibility projection through 2026-10-12, then remove it only after the
 * minimum supported plugin version excludes that release.
 */
export function loadSessionStore(
  storePath: string,
  options: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  // SQLite entry reads are direct and uncached, so beta.5's skipCache option
  // is already the only available behavior.
  void options.skipCache;
  const target = resolveLegacySessionStoreTarget(storePath);
  return Object.fromEntries(
    listAccessorSessionEntries({
      ...target,
      // SDK callers must never receive entries owned by the accessor cache.
      // Preserve the old wrapper's detached-result guarantee even when a
      // legacy caller passes clone: false.
      clone: true,
      hydrateSkillPromptRefs: options.hydrateSkillPromptRefs,
    }).map(({ sessionKey, entry }) => {
      const sessionId = entry.sessionId?.trim();
      if (entry.sessionFile || !sessionId) {
        return [sessionKey, entry];
      }
      return [
        sessionKey,
        {
          ...entry,
          // SQLite does not persist sessionFile. Beta.5 needs a locator only in
          // this detached projection so its file-based doctor reaches the bridge.
          sessionFile: formatSqliteSessionFileMarker({
            agentId: target.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
            sessionId,
            storePath: target.storePath,
          }),
        },
      ];
    }),
  );
}

/**
 * @deprecated Use patchSessionEntry, upsertSessionEntry, or deleteSessionEntry.
 *
 * Official plugins released with v2026.7.1-beta.5 import this symbol. Keep the
 * compatibility bridge through 2026-10-12. The callback mutates a detached
 * projection; the resulting row diff commits through the SQLite accessor.
 * Beta.5 memory-core already uses cleanupSessionLifecycleArtifacts; this
 * whole-store callback remains only for Feishu doctor's explicit repair flow.
 */
export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  options: UpdateSessionStoreOptions<T> = {},
): Promise<T> {
  const target = resolveLegacySessionStoreTarget(storePath);
  return await applyAccessorSessionStoreProjection({
    activeSessionKey: options.activeSessionKey,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    storePath: target.storePath,
    skipMaintenance: options.skipMaintenance,
    update: async (store) => {
      const result = await mutator(store);
      return {
        persist: !options.skipSaveWhenResult?.(result),
        result,
      };
    },
  });
}

/**
 * @deprecated Resolve transcript identities with loadTranscriptEventsSync.
 *
 * Beta.5 Feishu doctor still inspects JSONL paths synchronously. SQLite
 * markers therefore materialize a bounded export at the canonical legacy path
 * rather than making the old doctor classify every healthy transcript as
 * missing. These files are durable because beta.5 renames repaired transcripts
 * to recovery archives; remove this bridge only after beta.5 is unsupported.
 */
export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  options?: { agentId?: string; sessionsDir?: string },
): string {
  const resolved = resolveLegacySessionFilePath(sessionId, entry, options);
  return materializeLegacyTranscriptFile(resolved, options);
}

/**
 * Resolves the configured session store path.
 *
 * Beta.5 resolves a configured path with an agent id, then passes only the
 * path to loadSessionStore/updateSessionStore. Its shipped callers either
 * consume the selection synchronously or dedupe by path, so retaining the
 * latest selection preserves that bounded compatibility contract.
 */
export function resolveStorePath(
  store?: string,
  options?: { agentId?: string; env?: NodeJS.ProcessEnv },
): string {
  const storePath = resolveSessionStorePath(store, options);
  if (options?.agentId) {
    legacyStoreAgentIds.set(path.resolve(storePath), options.agentId);
  }
  return storePath;
}

/**
 * @deprecated Use getSessionEntry with a storage-neutral session identity.
 *
 * Official plugins released with v2026.7.1-beta.5 import this whole-store
 * lookup helper. Keep it through 2026-10-12 with the other beta.5 bridge.
 */
export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}) {
  return resolveSessionStoreEntryFromStore(params);
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
