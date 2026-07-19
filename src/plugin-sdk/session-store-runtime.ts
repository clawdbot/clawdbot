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
  resolveTranscriptSessionKeyBySessionId as resolveAccessorTranscriptSessionKeyBySessionId,
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
import type {
  AmbientTranscriptWatermark,
  InternalSessionEntry,
  SessionEntry,
} from "../config/sessions/types.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  activeRecoveryFieldsForSameSession,
  clearRecoveryStateForRotatedSessionPatch,
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
  projectPluginSessionStore,
  reconcilePluginSessionStore,
  type SessionStoreReadParams,
  toSessionAccessScope,
} from "./session-store-runtime-internal.js";
import type { SessionTranscriptEvent } from "./session-transcript-runtime.js";

const SQLITE_SESSION_STORE_BACKUP_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const LEGACY_TRANSCRIPT_INSPECTION_MAX_BYTES = 16 * 1024 * 1024;
// Beta.5 Codex resolves and loads synchronously; beta.5 Feishu dedupes targets
// by path before load/update. Last selection therefore matches every shipped
// caller. This map is not a general replacement for target-aware SDK methods.
const legacyStoreAgentIds = new Map<string, string>();

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

type UpdateSessionStoreEntryParams = {
  storePath: string;
  sessionKey: string;
  update: SessionStoreEntryUpdate;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type UpsertSessionEntryParams = SessionStoreReadParams & { entry: SessionEntry };

type ReadAmbientTranscriptWatermarkParams = SessionStoreReadParams & {
  key: string;
};

type DeleteSessionEntryParams = SessionStoreReadParams & {
  archiveTranscript?: boolean;
  expectedSessionId?: string | null;
  expectedUpdatedAt?: number;
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

function preserveCoreRecoveryState(
  persistedEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  const nextSessionId = Object.hasOwn(publicPatch, "sessionId")
    ? publicPatch.sessionId
    : persistedEntry.sessionId;
  const recoveryState = activeRecoveryFieldsForSameSession(persistedEntry, nextSessionId);
  return recoveryState
    ? { ...publicPatch, ...recoveryState }
    : clearRecoveryStateForRotatedSessionPatch(persistedEntry, publicPatch);
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
      const projectedEntry = projectPluginSessionEntry(entry as InternalSessionEntry);
      if (projectedEntry.sessionFile || !sessionId) {
        return [sessionKey, projectedEntry];
      }
      return [
        sessionKey,
        {
          ...projectedEntry,
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
      const internalStore = store as Record<string, InternalSessionEntry>;
      const publicStore = projectPluginSessionStore(internalStore);
      const result = await mutator(publicStore);
      const persist = !options.skipSaveWhenResult?.(result);
      if (persist) {
        // The deprecated callback owns public row changes and deletions, but
        // core recovery coordination remains invisible and non-overwritable.
        reconcilePluginSessionStore({ internalStore, publicStore });
      }
      return {
        persist,
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
  const entry = loadSessionEntry(toSessionAccessScope(params));
  return entry ? projectPluginSessionEntry(entry) : undefined;
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
  }).map(({ sessionKey, entry }) => ({
    sessionKey,
    entry: projectPluginSessionEntry(entry),
  }));
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
  const entry = await patchAccessorSessionEntry(
    toSessionAccessScope(params),
    async (internalEntry, context) => {
      const persistedEntry = internalEntry as InternalSessionEntry;
      const patch = await params.update(projectPluginSessionEntry(internalEntry), {
        existingEntry: context.existingEntry
          ? projectPluginSessionEntry(context.existingEntry)
          : undefined,
      });
      if (!patch) {
        return null;
      }
      return preserveCoreRecoveryState(persistedEntry, projectPluginSessionEntryPatch(patch));
    },
    {
      fallbackEntry: params.fallbackEntry
        ? projectPluginSessionEntry(params.fallbackEntry)
        : undefined,
      maintenanceConfig:
        params.maintenanceConfig !== undefined
          ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
          : undefined,
      preserveActivity: params.preserveActivity,
      requireWriteSuccess: params.requireWriteSuccess,
      replaceEntry: params.replaceEntry,
      skipMaintenance: params.skipMaintenance,
    },
  );
  return entry ? projectPluginSessionEntry(entry) : null;
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
  const entry = await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    async (internalEntry) => {
      const patch = await params.update(projectPluginSessionEntry(internalEntry));
      if (!patch) {
        return null;
      }
      const persistedEntry = internalEntry as InternalSessionEntry;
      return preserveCoreRecoveryState(persistedEntry, projectPluginSessionEntryPatch(patch));
    },
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
  return entry ? projectPluginSessionEntry(entry) : null;
}

/** Replaces or creates one session entry by agent/session identity. */
export async function upsertSessionEntry(params: UpsertSessionEntryParams): Promise<void> {
  const publicEntry = projectPluginSessionEntry(params.entry);
  await patchAccessorSessionEntry(
    toSessionAccessScope(params),
    (internalEntry) => {
      const persistedEntry = internalEntry as InternalSessionEntry;
      return preserveCoreRecoveryState(persistedEntry, publicEntry);
    },
    { fallbackEntry: publicEntry, replaceEntry: true },
  );
}

/** Deletes one session entry by agent/session identity. */
export async function deleteSessionEntry(params: DeleteSessionEntryParams): Promise<boolean> {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath =
    params.storePath ??
    resolveSessionStorePath(undefined, {
      agentId,
      env: params.env,
    });
  const result = await deleteAccessorSessionEntryLifecycle({
    ...(agentId !== undefined ? { agentId } : {}),
    archiveTranscript: params.archiveTranscript ?? false,
    ...(params.expectedSessionId !== undefined
      ? { expectedSessionId: params.expectedSessionId }
      : {}),
    ...(params.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: params.expectedUpdatedAt }
      : {}),
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
export type { SessionEntry } from "../config/sessions/types.js";
export type { SessionScope } from "../config/sessions/types.js";
