// Session store facade coordinates reads, writes, maintenance, delivery metadata, and exports.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import {
  pruneUnreferencedSessionArtifacts,
  type SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import { extractGeneratedTranscriptSessionId } from "./generated-transcript-session-id.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { resolveExplicitSessionFilePath, resolveSessionFilePath } from "./paths.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  isSessionSkillPromptBlobReadable,
  projectSessionStoreForPersistence,
  type SessionSkillPromptBlobProjection,
} from "./skill-prompt-blobs.js";
import {
  cloneSessionStoreRecord,
  dropSessionStoreObjectCache,
  dropSessionStoreSnapshotCache,
  getSerializedSessionStore,
  getSerializedSessionStorePromptRefs,
  getSessionStoreCacheVersion,
  invalidateSessionStoreCache,
  isSessionStoreCacheEnabled,
  setSerializedSessionStorePromptRefs,
  setSerializedSessionStore,
  takeMutableSessionStoreCache,
  writeSessionStoreCache,
} from "./store-cache.js";
import { resolveSessionStoreEntry } from "./store-entry.js";
import {
  loadSessionStore,
  normalizeSessionStore,
  readSessionEntries,
  readSessionEntry,
  stripPersistedSkillsCache,
} from "./store-load.js";
import {
  applyFileBackedSessionStoreMaintenance,
  type SessionMaintenanceApplyReport,
} from "./store-maintenance-operations.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  type ResolvedSessionMaintenanceConfig,
  type ResolvedSessionMaintenanceConfigInput,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
  type SessionSkillPromptRef,
} from "./types.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  getSessionStoreWriterQueueSizeForTest,
} from "./store-writer-state.js";
export {
  loadSessionStore,
  readSessionEntries,
  readSessionEntry,
  readSessionStoreSnapshot,
} from "./store-load.js";
export type {
  SessionStoreSnapshot,
  SessionStoreSnapshotEntries,
  SessionStoreSnapshotEntry,
} from "./store-cache.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";

export type SessionEntryPatchProjectionSnapshot = {
  entries: ReadonlyArray<{ sessionKey: string; entry: SessionEntry }>;
};

export type SessionEntryPatchProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

export type SessionEntryPatchProjectionContext = SessionEntryPatchProjectionSnapshot &
  SessionEntryPatchProjectionTarget & {
    existingEntry?: SessionEntry;
  };

export type SessionEntryPatchProjectionFailure = { ok: false };

export type SessionEntryPatchProjectionResult<TFailure extends SessionEntryPatchProjectionFailure> =
  { ok: true; entry: SessionEntry } | TFailure;

const log = createSubsystemLogger("sessions/store");
const writerStoreFileStats = new WeakMap<
  Record<string, SessionEntry>,
  ReturnType<typeof getFileStatSnapshot> | null
>();

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

const loadTrajectoryCleanupRuntime = createLazyRuntimeModule(
  () => import("../../trajectory/cleanup.js"),
);

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath, { clone: false });
    return resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  getSessionStoreCacheVersion,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  resolveMaintenanceConfig,
};
export type { SessionMaintenanceApplyReport } from "./store-maintenance-operations.js";
export type {
  ResolvedSessionMaintenanceConfig,
  ResolvedSessionMaintenanceConfigInput,
  SessionMaintenanceWarning,
};

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Caller already proved the store serialization is unchanged unless maintenance mutates it. */
  skipSerializeForUnchangedStore?: boolean;
  /** Internal hot paths can hand writer-owned stores to the cache after persistence. */
  takeCacheOwnership?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  /** Changed top-level entry when a hot path only updated one existing session. */
  singleEntryPersistence?: SingleEntryPersistencePatch;
  /** Throw when best-effort store recovery cannot confirm the requested write. */
  requireWriteSuccess?: boolean;
};

type UpdateSessionStoreOptions<T> = SaveSessionStoreOptions & {
  /** Allow a nested mutation only when the caller already owns this store writer lane. */
  reentrant?: boolean;
  /**
   * Specialized callers can prove their mutator made no changes through its result.
   * When true, the writer-owned object cache is restored and sessions.json is untouched.
   */
  skipSaveWhenResult?: (result: T) => boolean;
  resolveSingleEntryPersistence?: (result: T) => SingleEntryPersistencePatch | null | undefined;
};

type SingleEntryPersistencePatch = {
  sessionKey: string;
  entry: SessionEntry;
};

// The entry workflow helpers below are the file-backend implementation behind
// the session-accessor domain boundary and the plugin-SDK compatibility
// surface (RFC 0007). Internal runtime callers use session-accessor.ts; these
// become internal as direct callers migrate (#88838).
type SessionEntryWorkflowOptions = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  storePath?: string;
};

export type SessionLifecycleArtifactCleanupParams = {
  /** Session store to clean. */
  storePath: string;
  /** Archive exact transcripts referenced by removed entries before the orphan marker scan. */
  archiveRemovedEntryTranscripts?: boolean;
  /** Matches the persisted session-key segment after `agent:<id>:`. */
  sessionKeySegmentPrefix: string;
  /** Marker that identifies transcript artifacts owned by this lifecycle. */
  transcriptContentMarker: string;
  /** Minimum age before a present transcript can be reclaimed or archived. */
  orphanTranscriptMinAgeMs: number;
  /** Testable clock override. */
  nowMs?: number;
};

export type SessionLifecycleArtifactCleanupResult = {
  removedEntries: number;
  archivedTranscriptArtifacts: number;
};

export type SessionLifecycleStoreTarget = {
  /** Canonical persisted key for the entry being reset or deleted. */
  canonicalKey: string;
  /** Canonical key plus legacy aliases that can still identify the same entry. */
  storeKeys: string[];
};

export type SessionLifecycleArchivedTranscript = {
  sourcePath: string;
  archivedPath: string;
};

export type ResetSessionEntryLifecycleResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  previousEntry?: SessionEntry;
  previousSessionFile?: string;
  previousSessionId?: string;
  nextEntry: SessionEntry;
};

export type ResetSessionEntryLifecycleMutation = Omit<
  ResetSessionEntryLifecycleResult,
  "archivedTranscripts"
>;

export type DeleteSessionEntryLifecycleResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  deleted: boolean;
  expectedEntryMismatch?: true;
  deletedEntry?: SessionEntry;
  deletedSessionFile?: string;
  deletedSessionId?: string;
};

export type SessionEntryLifecycleRemoval = {
  /** Exact persisted key to remove from the store. */
  sessionKey: string;
  /** Optional full-entry guard for plans built before the writer lock. */
  expectedEntry?: SessionEntry;
  /** Archive the removed entry's transcript only when no final store entry still references it. */
  archiveRemovedTranscript?: boolean;
  /** Optional guard for stale plans built from a prior store read. */
  expectedSessionId?: string;
  /** Optional guard for stale plans built from a prior store read. */
  expectedUpdatedAt?: number;
};

export type SessionEntryLifecycleUpsert = {
  /** Exact persisted key to create or replace. */
  sessionKey: string;
} & (
  | {
      /** Entry to persist at the exact key. */
      entry: SessionEntry;
      buildEntry?: never;
    }
  | {
      /** Builds the persisted entry after the storage writer lock is held. */
      buildEntry: (context: {
        currentEntry?: SessionEntry;
        sessionKey: string;
        store: Record<string, SessionEntry>;
      }) => Promise<SessionEntry | null | undefined> | SessionEntry | null | undefined;
      entry?: never;
    }
);

export type SessionArchivedTranscriptCleanupRule = {
  reason: "deleted" | "reset";
  olderThanMs: number;
};

export type SessionEntryLifecycleMutationResult = {
  removedEntries: number;
  removedSessionKeys: string[];
  archivedTranscriptDirectories: string[];
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult | null;
  maintenanceReport: SessionMaintenanceApplyReport | null;
  afterCount: number;
  artifactCleanupError?: unknown;
};

export type DeletedAgentSessionEntryPurgeParams = {
  /** Runtime config used to preserve legacy default-agent key ownership rules. */
  cfg: OpenClawConfig;
  /** Deleted agent whose session entries should be purged. */
  agentId: string;
  /** Agent id represented by the current store path for legacy unscoped keys. */
  storeAgentId: string;
  /** Resolved session store path to mutate. */
  storePath: string;
};

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return cloneSessionStoreRecord({ entry }).entry;
}

export function projectSessionEntryForPersistenceRevision(params: {
  storePath: string;
  entry: SessionEntry;
}): SessionEntry {
  const stripped = stripPersistedSkillsCache(params.entry);
  const projected = projectSessionStoreForPersistence({
    storePath: params.storePath,
    store: { entry: stripped },
  });
  return projected.store.entry ?? stripped;
}

export function getSessionEntry(
  options: SessionEntryWorkflowOptions & { sessionKey: string },
): SessionEntry | undefined {
  const entry = readSessionEntry(resolveSessionStorePathForScope(options), options.sessionKey, {
    hydrateSkillPromptRefs: options.hydrateSkillPromptRefs,
  }) as SessionEntry | undefined;
  return entry ? cloneSessionEntry(entry) : undefined;
}

export function listSessionEntries(
  options: SessionEntryWorkflowOptions = {},
): Array<{ sessionKey: string; entry: SessionEntry }> {
  return readSessionEntries(resolveSessionStorePathForScope(options)).map(
    ([sessionKey, entry]) => ({
      sessionKey,
      entry: cloneSessionEntry(entry as SessionEntry),
    }),
  );
}

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
  serializedPromptRefs?: ReadonlyMap<string, SessionSkillPromptRef>;
  cloneSerialized?: string;
  takeOwnership?: boolean;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(
    params.storePath,
    params.serialized,
    fileStat?.sizeBytes,
    params.serializedPromptRefs,
  );
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    dropSessionStoreSnapshotCache(params.storePath);
    return;
  }
  writeSessionStoreCache({
    storePath: params.storePath,
    store: params.store,
    mtimeMs: fileStat?.mtimeMs,
    sizeBytes: fileStat?.sizeBytes,
    serialized: params.serialized,
    serializedPromptRefs: params.serializedPromptRefs,
    cloneSerialized: params.cloneSerialized,
    takeOwnership: params.takeOwnership,
  });
  dropSessionStoreSnapshotCache(params.storePath);
}

function restoreUnchangedSessionStoreCache(
  storePath: string,
  store: Record<string, SessionEntry>,
): void {
  if (!isSessionStoreCacheEnabled()) {
    return;
  }
  const loadedFileStat = writerStoreFileStats.get(store) ?? null;
  const currentFileStat = getFileStatSnapshot(storePath) ?? null;
  if (
    loadedFileStat?.mtimeMs !== currentFileStat?.mtimeMs ||
    loadedFileStat?.sizeBytes !== currentFileStat?.sizeBytes
  ) {
    invalidateSessionStoreCache(storePath);
    return;
  }
  const serialized = getSerializedSessionStore(storePath);
  const serializedPromptRefs =
    serialized !== undefined ? getSerializedSessionStorePromptRefs(storePath) : undefined;
  writeSessionStoreCache({
    storePath,
    store,
    mtimeMs: loadedFileStat?.mtimeMs,
    sizeBytes: loadedFileStat?.sizeBytes,
    serialized,
    serializedPromptRefs,
    takeOwnership: true,
  });
  if (serialized !== undefined) {
    // Keep hydrated blob prompts in the object cache, but preserve the disk JSON
    // comparison string so repeated no-op saves do not rewrite sessions.json.
    setSerializedSessionStore(
      storePath,
      serialized,
      loadedFileStat?.sizeBytes,
      serializedPromptRefs,
    );
  }
}

function findJsonValueEnd(json: string, valueStart: number): number | null {
  // Single-entry persistence rewrites one top-level JSON value; this scanner finds its end without
  // reparsing the whole store string.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = valueStart; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index + 1;
    }
    if (depth < 0) {
      return null;
    }
  }
  return null;
}

function indentTopLevelEntryJson(json: string): string {
  return json.replaceAll("\n", "\n  ");
}

function buildSingleEntrySerializedStore(params: {
  storePath: string;
  patch: SingleEntryPersistencePatch;
}): {
  serialized: string;
  promptBlobs: SessionSkillPromptBlobProjection[];
  promptRefs: ReadonlyMap<string, SessionSkillPromptRef>;
} | null {
  const currentSerialized = getSerializedSessionStore(params.storePath);
  if (currentSerialized === undefined) {
    return null;
  }
  const currentPromptRefs = getSerializedPromptRefs(params.storePath, currentSerialized);
  const marker = `\n  ${JSON.stringify(params.patch.sessionKey)}: `;
  const markerIndex = currentSerialized.indexOf(marker);
  // Fast path only handles existing pretty-printed top-level entries in the cached JSON shape.
  if (markerIndex < 0) {
    return null;
  }
  const valueStart = markerIndex + marker.length;
  if (currentSerialized[valueStart] !== "{") {
    return null;
  }
  const valueEnd = findJsonValueEnd(currentSerialized, valueStart);
  if (valueEnd === null) {
    return null;
  }
  const projected = projectSessionStoreForPersistence({
    storePath: params.storePath,
    store: { [params.patch.sessionKey]: params.patch.entry },
  });
  const projectedEntry = projected.store[params.patch.sessionKey];
  if (!projectedEntry) {
    return null;
  }
  const entryJson = indentTopLevelEntryJson(JSON.stringify(projectedEntry, null, 2));
  const promptRefs = new Map(currentPromptRefs);
  const promptRef = projectedEntry.skillsSnapshot?.promptRef;
  if (promptRef) {
    promptRefs.set(params.patch.sessionKey, promptRef);
  } else {
    promptRefs.delete(params.patch.sessionKey);
  }
  return {
    serialized:
      currentSerialized.slice(0, valueStart) + entryJson + currentSerialized.slice(valueEnd),
    promptBlobs: [...projected.promptBlobs.values()],
    promptRefs,
  };
}

function collectSerializedPromptRefs(serialized: string): Map<string, SessionSkillPromptRef> {
  const refs = new Map<string, SessionSkillPromptRef>();
  try {
    const parsed = JSON.parse(serialized) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(parsed)) {
      const ref = entry?.skillsSnapshot?.promptRef;
      if (ref) {
        refs.set(key, ref);
      }
    }
  } catch {
    // Malformed serialized cache cannot prove prompt refs are already durable.
  }
  return refs;
}

function collectStorePromptRefs(
  store: Record<string, SessionEntry>,
): Map<string, SessionSkillPromptRef> {
  const refs = new Map<string, SessionSkillPromptRef>();
  for (const [key, entry] of Object.entries(store)) {
    const ref = entry?.skillsSnapshot?.promptRef;
    if (ref) {
      refs.set(key, ref);
    }
  }
  return refs;
}

function getSerializedPromptRefs(
  storePath: string,
  serialized: string,
): ReadonlyMap<string, SessionSkillPromptRef> {
  const cached = getSerializedSessionStorePromptRefs(storePath);
  if (cached) {
    return cached;
  }
  const refs = collectSerializedPromptRefs(serialized);
  setSerializedSessionStorePromptRefs(storePath, refs);
  return refs;
}

function storeHasUnsafeUntouchedHydratedSkillPrompts(
  storePath: string,
  store: Record<string, SessionEntry>,
  changedSessionKey: string,
): boolean {
  const currentSerialized = getSerializedSessionStore(storePath);
  const serializedPromptRefs =
    currentSerialized !== undefined
      ? getSerializedPromptRefs(storePath, currentSerialized)
      : undefined;
  for (const [key, entry] of Object.entries(store)) {
    // If another hydrated entry lost its durable blob, single-entry JSON surgery would persist a
    // store that cannot rehydrate that prompt later.
    if (key === changedSessionKey || typeof entry.skillsSnapshot?.prompt !== "string") {
      continue;
    }
    const ref = serializedPromptRefs?.get(key);
    if (!ref || !isSessionSkillPromptBlobReadable(storePath, ref)) {
      return true;
    }
    if (serializedPromptRefs?.has(key)) {
      const projected = projectSessionStoreForPersistence({ storePath, store: { [key]: entry } });
      for (const blob of projected.promptBlobs.values()) {
        if (!blob.path) {
          continue;
        }
        try {
          const stat = fs.statSync(blob.path);
          if (!stat.isFile() || stat.size !== blob.ref.bytes) {
            return true;
          }
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

function loadMutableSessionStoreForWriter(storePath: string): Record<string, SessionEntry> {
  const currentFileStat = getFileStatSnapshot(storePath);
  if (isSessionStoreCacheEnabled()) {
    const cached = takeMutableSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
    });
    if (cached) {
      writerStoreFileStats.set(cached, currentFileStat ?? null);
      return cached;
    }
  }
  const store = loadSessionStore(storePath, { skipCache: true, clone: false });
  writerStoreFileStats.set(store, currentFileStat ?? null);
  return store;
}

function sessionEntriesHaveSameSerializedForm(
  previous: SessionEntry | undefined,
  next: SessionEntry,
): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next);
}

function cloneOptionalSessionEntry(entry: SessionEntry | undefined): SessionEntry | undefined {
  return entry ? cloneSessionEntry(entry) : undefined;
}

function resolveLifecyclePrimaryEntry(params: {
  store: Record<string, SessionEntry>;
  target: SessionLifecycleStoreTarget;
}): SessionEntry | undefined {
  const primaryEntry = resolveLifecyclePrimaryEntrySnapshot(params);
  if (primaryEntry) {
    params.store[params.target.canonicalKey] = primaryEntry;
  }
  pruneLifecycleLegacyStoreKeys({
    store: params.store,
    target: params.target,
  });
  return params.store[params.target.canonicalKey];
}

function resolveLifecyclePrimaryEntrySnapshot(params: {
  store: Record<string, SessionEntry>;
  target: SessionLifecycleStoreTarget;
}): SessionEntry | undefined {
  const currentPrimary = params.store[params.target.canonicalKey];
  const freshestMatch = resolveFreshestLifecycleStoreMatch({
    store: params.store,
    storeKeys: params.target.storeKeys,
  });
  if (
    freshestMatch &&
    (!currentPrimary || (freshestMatch.entry.updatedAt ?? 0) > (currentPrimary.updatedAt ?? 0))
  ) {
    return freshestMatch.entry;
  }
  return currentPrimary;
}

function resolveFreshestLifecycleStoreMatch(params: {
  store: Record<string, SessionEntry>;
  storeKeys: string[];
}): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of params.storeKeys) {
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (!freshest || (entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

function pruneLifecycleLegacyStoreKeys(params: {
  store: Record<string, SessionEntry>;
  target: SessionLifecycleStoreTarget;
}): void {
  for (const key of params.target.storeKeys) {
    if (key !== params.target.canonicalKey) {
      delete params.store[key];
    }
  }
}

async function archiveLifecycleSessionTranscripts(params: {
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): Promise<SessionLifecycleArchivedTranscript[]> {
  if (!params.sessionId) {
    return [];
  }
  const { archiveSessionTranscriptsDetailed } = await loadSessionArchiveRuntime();
  return archiveSessionTranscriptsDetailed({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

function ensureLifecycleTranscriptHeader(params: { sessionFile: string; sessionId: string }): void {
  fs.mkdirSync(path.dirname(params.sessionFile), { recursive: true });
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function normalizePathForLifecycleComparison(filePath: string): string {
  try {
    return path.normalize(fs.realpathSync(filePath));
  } catch {
    return path.normalize(path.resolve(filePath));
  }
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function resolveLifecycleTranscriptPath(params: {
  entry: SessionEntry | undefined;
  sessionsDir: string;
}): string | null {
  const sessionId = params.entry?.sessionId?.trim();
  const sessionFile = params.entry?.sessionFile?.trim();
  const generatedSessionId = extractGeneratedTranscriptSessionId(sessionFile);
  if (sessionFile && (!sessionId || !generatedSessionId || generatedSessionId === sessionId)) {
    try {
      return resolveExplicitSessionFilePath(sessionFile, { sessionsDir: params.sessionsDir });
    } catch {
      return null;
    }
  }
  if (!sessionId) {
    return null;
  }
  try {
    return resolveSessionFilePath(sessionId, undefined, { sessionsDir: params.sessionsDir });
  } catch {
    return null;
  }
}

function lifecycleTranscriptIsReclaimable(params: {
  transcriptPath: string | null;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  if (!params.transcriptPath || !fs.existsSync(params.transcriptPath)) {
    return true;
  }
  try {
    const stat = fs.statSync(params.transcriptPath);
    return params.nowMs - stat.mtimeMs >= params.orphanTranscriptMinAgeMs;
  } catch {
    return true;
  }
}

function archiveExactLifecycleTranscriptPath(params: {
  sessionsDir: string;
  transcriptPath: string;
}): number {
  const resolvedSessionsDir = normalizePathForLifecycleComparison(params.sessionsDir);
  const resolvedTranscriptPath = normalizePathForLifecycleComparison(params.transcriptPath);
  const relative = path.relative(resolvedSessionsDir, resolvedTranscriptPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return 0;
  }
  const archivedPath = `${resolvedTranscriptPath}.deleted.${formatSessionArchiveTimestamp()}`;
  try {
    fs.renameSync(resolvedTranscriptPath, archivedPath);
    emitSessionTranscriptUpdate({ sessionFile: archivedPath });
    return 1;
  } catch {
    return 0;
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionStore(store);

  let maintenanceChangedStore = false;
  if (!opts?.skipMaintenance) {
    const maintenance = await applyFileBackedSessionStoreMaintenance({
      storePath,
      store,
      activeSessionKey: opts?.activeSessionKey,
      onWarn: opts?.onWarn,
      onMaintenanceApplied: opts?.onMaintenanceApplied,
      maintenanceOverride: opts?.maintenanceOverride,
      maintenanceConfig: opts?.maintenanceConfig,
      log,
      artifacts: {
        archiveRemovedSessionTranscripts,
        removeRemovedSessionTrajectoryArtifacts: async (params) => {
          const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
          await removeRemovedSessionTrajectoryArtifacts(params);
        },
        cleanupArchivedSessionTranscripts: async (params) => {
          const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
          await cleanupArchivedSessionTranscripts(params);
        },
      },
    });
    maintenanceChangedStore = maintenance.changedStore;
  }

  if (
    opts?.skipSerializeForUnchangedStore &&
    !maintenanceChangedStore &&
    getSerializedSessionStore(storePath) !== undefined
  ) {
    restoreUnchangedSessionStoreCache(storePath, store);
    return;
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  if (
    opts?.singleEntryPersistence &&
    !maintenanceChangedStore &&
    !storeHasUnsafeUntouchedHydratedSkillPrompts(
      storePath,
      store,
      opts.singleEntryPersistence.sessionKey,
    )
  ) {
    // Hot path for updating one entry: preserve the cached serialized store and replace only that
    // entry's JSON when no maintenance or prompt-blob repair needs a full rewrite.
    const normalizedEntry = store[opts.singleEntryPersistence.sessionKey];
    const singleEntrySerialized = buildSingleEntrySerializedStore({
      storePath,
      patch: normalizedEntry
        ? {
            sessionKey: opts.singleEntryPersistence.sessionKey,
            entry: normalizedEntry,
          }
        : opts.singleEntryPersistence,
    });
    if (singleEntrySerialized) {
      await writeSessionStoreAtomic({
        storePath,
        store,
        serialized: singleEntrySerialized.serialized,
        serializedPromptRefs: singleEntrySerialized.promptRefs,
        promptBlobs: singleEntrySerialized.promptBlobs,
        takeOwnership: opts?.takeCacheOwnership,
      });
      return;
    }
  }
  const persisted = projectSessionStoreForPersistence({ storePath, store });
  const promptBlobs = [...persisted.promptBlobs.values()];
  const promptRefs = collectStorePromptRefs(persisted.store);
  const json = JSON.stringify(persisted.store, null, 2);
  const cloneSerialized = persisted.changed ? undefined : json;
  if (getSerializedSessionStore(storePath) === json) {
    await ensureSessionStorePromptBlobsForPersistence({
      storePath,
      promptBlobs,
    });
    updateSessionStoreWriteCaches({
      storePath,
      store,
      serialized: json,
      serializedPromptRefs: promptRefs,
      cloneSerialized,
      takeOwnership: opts?.takeCacheOwnership,
    });
    return;
  }

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    let finalError: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await writeSessionStoreAtomic({
          storePath,
          store,
          serialized: json,
          serializedPromptRefs: promptRefs,
          cloneSerialized,
          promptBlobs,
          takeOwnership: opts?.takeCacheOwnership,
        });
        return;
      } catch (err) {
        finalError = err;
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          if (opts?.requireWriteSuccess) {
            throw err;
          }
          return;
        }
        if (i < 4) {
          await new Promise((r) => {
            setTimeout(r, 50 * (i + 1));
          });
          continue;
        }
        // Final attempt failed - skip this save. The writer queue ensures
        // the next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    if (opts?.requireWriteSuccess) {
      throw finalError;
    }
    return;
  }

  try {
    await writeSessionStoreAtomic({
      storePath,
      store,
      serialized: json,
      serializedPromptRefs: promptRefs,
      cloneSerialized,
      promptBlobs,
      takeOwnership: opts?.takeCacheOwnership,
    });
  } catch (err) {
    const code = getErrorCode(err);

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeSessionStoreAtomic({
          storePath,
          store,
          serialized: json,
          serializedPromptRefs: promptRefs,
          cloneSerialized,
          promptBlobs,
          takeOwnership: opts?.takeCacheOwnership,
        });
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          if (opts?.requireWriteSuccess) {
            throw err2;
          }
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await runExclusiveSessionStoreWrite(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: UpdateSessionStoreOptions<T>,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(
    storePath,
    async () => {
      const store = loadMutableSessionStoreForWriter(storePath);
      const result = await mutator(store);
      if (opts?.skipSaveWhenResult?.(result)) {
        restoreUnchangedSessionStoreCache(storePath, store);
        return result;
      }
      await saveSessionStoreUnlocked(storePath, store, {
        ...opts,
        singleEntryPersistence: opts?.resolveSingleEntryPersistence?.(result) ?? undefined,
      });
      return result;
    },
    { reentrant: opts?.reentrant },
  );
}

function cloneSessionEntryProjectionSnapshot(
  store: Record<string, SessionEntry>,
): SessionEntryPatchProjectionSnapshot {
  return {
    entries: Object.entries(store).map(([sessionKey, entry]) => ({
      sessionKey,
      entry: cloneSessionEntry(entry),
    })),
  };
}

function resolveFreshestProjectedEntry(params: {
  store: Record<string, SessionEntry>;
  candidateKeys: readonly string[];
}): SessionEntry | undefined {
  let freshest: SessionEntry | undefined;
  const keys = new Set<string>();
  for (const candidateKey of params.candidateKeys) {
    const trimmed = normalizeOptionalString(candidateKey) ?? "";
    if (!trimmed) {
      continue;
    }
    keys.add(trimmed);
  }
  for (const key of keys) {
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    if (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0)) {
      freshest = entry;
    }
  }
  return freshest;
}

function migrateSessionEntryProjectionTarget(params: {
  store: Record<string, SessionEntry>;
  target: SessionEntryPatchProjectionTarget;
}): void {
  const candidateKeys = params.target.candidateKeys ?? [params.target.primaryKey];
  const freshest = resolveFreshestProjectedEntry({
    store: params.store,
    candidateKeys,
  });
  const currentPrimary = params.store[params.target.primaryKey];
  if (
    freshest &&
    (!currentPrimary || (freshest.updatedAt ?? 0) > (currentPrimary.updatedAt ?? 0))
  ) {
    params.store[params.target.primaryKey] = freshest;
  }

  const keysToDelete = new Set<string>();
  for (const candidateKey of candidateKeys) {
    const trimmed = normalizeOptionalString(candidateKey) ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed !== params.target.primaryKey) {
      keysToDelete.add(trimmed);
    }
  }
  for (const key of keysToDelete) {
    delete params.store[key];
  }
}

/**
 * Applies a storage-neutral entry projection inside the session-store writer.
 * The projection receives a cloned snapshot and returns the replacement entry;
 * it cannot mutate the backing whole store.
 */
export async function applySessionEntryPatchProjection<
  TFailure extends SessionEntryPatchProjectionFailure,
>(params: {
  storePath: string;
  resolveTarget: (
    snapshot: SessionEntryPatchProjectionSnapshot,
  ) => SessionEntryPatchProjectionTarget;
  project: (
    context: SessionEntryPatchProjectionContext,
  ) =>
    | Promise<SessionEntryPatchProjectionResult<TFailure>>
    | SessionEntryPatchProjectionResult<TFailure>;
}): Promise<SessionEntryPatchProjectionResult<TFailure>> {
  return await runExclusiveSessionStoreWrite(params.storePath, async () => {
    const store = loadMutableSessionStoreForWriter(params.storePath);
    const target = params.resolveTarget(cloneSessionEntryProjectionSnapshot(store));
    migrateSessionEntryProjectionTarget({ store, target });
    const projected = await params.project({
      ...target,
      entries: cloneSessionEntryProjectionSnapshot(store).entries,
      ...(store[target.primaryKey]
        ? { existingEntry: cloneSessionEntry(store[target.primaryKey]) }
        : {}),
    });
    if (projected.ok) {
      store[target.primaryKey] = cloneSessionEntry(projected.entry);
    }
    await saveSessionStoreUnlocked(params.storePath, store, {
      activeSessionKey: target.primaryKey,
    });
    return projected.ok ? { ...projected, entry: cloneSessionEntry(projected.entry) } : projected;
  });
}

/** Resets one persisted session entry and rotates its file-backed transcript artifacts. */
export async function resetSessionEntryLifecycle(params: {
  afterEntryMutation?: (mutation: ResetSessionEntryLifecycleMutation) => Promise<void> | void;
  agentId?: string;
  buildNextEntry: (context: {
    currentEntry?: SessionEntry;
    primaryKey: string;
  }) => Promise<SessionEntry> | SessionEntry;
  storePath: string;
  target: SessionLifecycleStoreTarget;
}): Promise<ResetSessionEntryLifecycleResult> {
  return await runExclusiveSessionStoreWrite(params.storePath, async () => {
    const store = loadMutableSessionStoreForWriter(params.storePath);
    const currentEntry = resolveLifecyclePrimaryEntry({
      store,
      target: params.target,
    });
    const previousSessionId = currentEntry?.sessionId;
    const previousSessionFile = currentEntry?.sessionFile;
    const nextEntry = await params.buildNextEntry({
      currentEntry: cloneOptionalSessionEntry(currentEntry),
      primaryKey: params.target.canonicalKey,
    });
    const nextSessionFile = nextEntry.sessionFile?.trim();
    if (!nextSessionFile) {
      throw new Error("reset session lifecycle requires next entry sessionFile");
    }
    store[params.target.canonicalKey] = nextEntry;
    await saveSessionStoreUnlocked(params.storePath, store);
    const mutation: ResetSessionEntryLifecycleMutation = {
      nextEntry: cloneSessionEntry(nextEntry),
    };
    const previousEntry = cloneOptionalSessionEntry(currentEntry);
    if (previousEntry) {
      mutation.previousEntry = previousEntry;
    }
    if (previousSessionFile) {
      mutation.previousSessionFile = previousSessionFile;
    }
    if (previousSessionId) {
      mutation.previousSessionId = previousSessionId;
    }
    const reusesTranscriptPath =
      previousSessionFile !== undefined &&
      normalizePathForLifecycleComparison(previousSessionFile) ===
        normalizePathForLifecycleComparison(nextSessionFile);
    // Generated successor paths must exist before callbacks can checkpoint them.
    // Reused custom paths keep the old callback/archive/header order to preserve observer semantics.
    if (!reusesTranscriptPath) {
      ensureLifecycleTranscriptHeader({
        sessionFile: nextSessionFile,
        sessionId: nextEntry.sessionId,
      });
    }
    await params.afterEntryMutation?.(mutation);
    const archivedTranscripts = await archiveLifecycleSessionTranscripts({
      sessionId: previousSessionId,
      storePath: params.storePath,
      sessionFile: previousSessionFile,
      agentId: params.agentId,
      reason: "reset",
    });
    if (reusesTranscriptPath) {
      ensureLifecycleTranscriptHeader({
        sessionFile: nextSessionFile,
        sessionId: nextEntry.sessionId,
      });
    }
    const result: ResetSessionEntryLifecycleResult = {
      ...mutation,
      archivedTranscripts,
    };
    return result;
  });
}

/** Deletes one persisted session entry and archives its file-backed transcript artifacts. */
export async function deleteSessionEntryLifecycle(params: {
  agentId?: string;
  archiveTranscript: boolean;
  expectedEntry?: SessionEntry;
  expectedLifecycleRevision?: string;
  expectedSessionId?: string;
  expectedUpdatedAt?: number;
  requireWriteSuccess?: boolean;
  storePath: string;
  target: SessionLifecycleStoreTarget;
}): Promise<DeleteSessionEntryLifecycleResult> {
  return await runExclusiveSessionStoreWrite(params.storePath, async () => {
    const store = loadMutableSessionStoreForWriter(params.storePath);
    // Compare against an unmodified snapshot. Alias promotion is itself a
    // mutation and must not enter the cache when a guarded delete is rejected.
    const deletedEntry = resolveLifecyclePrimaryEntrySnapshot({
      store,
      target: params.target,
    });
    if (!deletedEntry) {
      restoreUnchangedSessionStoreCache(params.storePath, store);
      return {
        archivedTranscripts: [],
        deleted: false,
      };
    }
    const expectedEntryMatches =
      params.expectedEntry === undefined ||
      JSON.stringify(deletedEntry) === JSON.stringify(params.expectedEntry);
    const expectedLifecycleRevisionMatches =
      params.expectedLifecycleRevision === undefined ||
      deletedEntry.lifecycleRevision === params.expectedLifecycleRevision;
    const expectedSessionIdMatches =
      !params.expectedSessionId ||
      deletedEntry.sessionId === params.expectedSessionId ||
      (deletedEntry.sessionId === undefined &&
        params.expectedLifecycleRevision !== undefined &&
        expectedLifecycleRevisionMatches);
    const expectedUpdatedAtMatches =
      params.expectedUpdatedAt === undefined || deletedEntry.updatedAt === params.expectedUpdatedAt;
    if (
      !expectedEntryMatches ||
      !expectedLifecycleRevisionMatches ||
      !expectedSessionIdMatches ||
      !expectedUpdatedAtMatches
    ) {
      restoreUnchangedSessionStoreCache(params.storePath, store);
      return {
        archivedTranscripts: [],
        deleted: false,
        expectedEntryMismatch: true,
      };
    }
    pruneLifecycleLegacyStoreKeys({ store, target: params.target });
    const deletedSessionId = deletedEntry.sessionId;
    const deletedSessionFile = deletedEntry.sessionFile;
    delete store[params.target.canonicalKey];
    await saveSessionStoreUnlocked(params.storePath, store, {
      requireWriteSuccess: params.requireWriteSuccess,
    });
    const archivedTranscripts = params.archiveTranscript
      ? await archiveLifecycleSessionTranscripts({
          sessionId: deletedSessionId,
          storePath: params.storePath,
          sessionFile: deletedSessionFile,
          agentId: params.agentId,
          reason: "deleted",
        })
      : [];
    const result: DeleteSessionEntryLifecycleResult = {
      archivedTranscripts,
      deleted: true,
    };
    result.deletedEntry = cloneSessionEntry(deletedEntry);
    if (deletedSessionFile) {
      result.deletedSessionFile = deletedSessionFile;
    }
    if (deletedSessionId) {
      result.deletedSessionId = deletedSessionId;
    }
    return result;
  });
}

function shouldRemoveSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    JSON.stringify(entry) !== JSON.stringify(removal.expectedEntry)
  ) {
    return false;
  }
  if (removal.expectedSessionId !== undefined && entry.sessionId !== removal.expectedSessionId) {
    return false;
  }
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
}

/**
 * Applies exact entry removals/upserts and lifecycle artifact cleanup as one
 * backend-owned operation. Callers choose domain keys; storage owns the final
 * referenced-session set used for transcript/artifact cleanup.
 */
export async function applySessionEntryLifecycleMutation(params: {
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  archiveReason?: "deleted" | "reset";
  restrictArchivedTranscriptsToStoreDir?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  pruneUnreferencedArtifacts?: {
    olderThanMs: number;
    dryRun?: boolean;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  const storePath = path.resolve(params.storePath);
  const removedSessionFiles = new Map<string, string | undefined>();
  const removedSessionKeys: string[] = [];
  const archivedTranscriptDirectories: string[] = [];
  let unreferencedArtifacts: SessionUnreferencedArtifactSweepResult | null = null;
  let maintenanceReport: SessionMaintenanceApplyReport | null = null;
  let afterCount = 0;
  let artifactCleanupError: unknown;

  await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    for (const removal of params.removals ?? []) {
      const sessionKey = removal.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      const entry = store[sessionKey];
      if (!shouldRemoveSessionEntry(entry, removal)) {
        continue;
      }
      if (removal.archiveRemovedTranscript === true && entry.sessionId) {
        rememberRemovedSessionFile(removedSessionFiles, entry);
      }
      delete store[sessionKey];
      removedSessionKeys.push(sessionKey);
    }
    for (const upsert of params.upserts ?? []) {
      const sessionKey = upsert.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      const entry =
        upsert.buildEntry === undefined
          ? upsert.entry
          : await upsert.buildEntry({
              currentEntry: store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined,
              sessionKey,
              store,
            });
      if (!entry) {
        continue;
      }
      store[sessionKey] = cloneSessionEntry(entry);
    }

    await saveSessionStoreUnlocked(storePath, store, {
      activeSessionKey: params.activeSessionKey,
      maintenanceOverride: params.maintenanceOverride,
      skipMaintenance: params.skipMaintenance,
      onMaintenanceApplied: (report) => {
        maintenanceReport = report;
      },
    });
    afterCount = Object.keys(store).length;

    const cleanupArtifacts = async () => {
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId)),
      );
      if (removedSessionFiles.size > 0) {
        const archivedDirs = await archiveRemovedSessionTranscripts({
          removedSessionFiles,
          referencedSessionIds,
          storePath,
          reason: params.archiveReason ?? "deleted",
          restrictToStoreDir: params.restrictArchivedTranscriptsToStoreDir,
        });
        archivedTranscriptDirectories.push(...[...archivedDirs].toSorted());
        if (archivedDirs.size > 0 && params.cleanupArchivedTranscripts) {
          const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
          await cleanupArchivedSessionTranscripts({
            directories: [...archivedDirs],
            rules: params.cleanupArchivedTranscripts.rules,
            nowMs: params.cleanupArchivedTranscripts.nowMs,
          });
        }
      }
      if (params.pruneUnreferencedArtifacts) {
        unreferencedArtifacts = await pruneUnreferencedSessionArtifacts({
          store,
          storePath,
          olderThanMs: params.pruneUnreferencedArtifacts.olderThanMs,
          dryRun: params.pruneUnreferencedArtifacts.dryRun,
        });
      }
    };

    try {
      await cleanupArtifacts();
    } catch (err) {
      if (params.captureArtifactCleanupError === true) {
        artifactCleanupError = err;
      } else {
        throw err;
      }
    }
  });

  return {
    removedEntries: removedSessionKeys.length,
    removedSessionKeys,
    archivedTranscriptDirectories,
    unreferencedArtifacts,
    maintenanceReport,
    afterCount,
    artifactCleanupError,
  };
}

/**
 * Purges entries owned by a deleted agent while holding the store writer lock.
 * This preserves the old delete-time current-store owner check without
 * exposing a mutable whole-store callback to callers.
 */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  const storePath = path.resolve(params.storePath);
  const removedSessionKeys: string[] = [];
  let maintenanceReport: SessionMaintenanceApplyReport | null = null;
  let afterCount = 0;

  await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    for (const sessionKey of Object.keys(store)) {
      const ownerAgentId = resolveStoredSessionOwnerAgentId({
        cfg: params.cfg,
        agentId: params.storeAgentId,
        sessionKey,
      });
      if (ownerAgentId === params.agentId) {
        delete store[sessionKey];
        removedSessionKeys.push(sessionKey);
      }
    }
    await saveSessionStoreUnlocked(storePath, store, {
      onMaintenanceApplied: (report) => {
        maintenanceReport = report;
      },
    });
    afterCount = Object.keys(store).length;
  });

  return {
    removedEntries: removedSessionKeys.length,
    removedSessionKeys,
    archivedTranscriptDirectories: [],
    unreferencedArtifacts: null,
    maintenanceReport,
    afterCount,
  };
}

async function archiveUnreferencedLifecycleTranscriptArtifacts(params: {
  storePath: string;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): Promise<number> {
  const sessionsDir = path.dirname(path.resolve(params.storePath));
  return await runExclusiveSessionStoreWrite(params.storePath, async () => {
    const store = loadMutableSessionStoreForWriter(params.storePath);
    const referencedTranscriptPaths = new Set<string>();
    for (const entry of Object.values(store)) {
      const transcriptPath = resolveLifecycleTranscriptPath({ entry, sessionsDir });
      if (transcriptPath) {
        referencedTranscriptPaths.add(normalizePathForLifecycleComparison(transcriptPath));
      }
    }
    restoreUnchangedSessionStoreCache(params.storePath, store);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
    let archived = 0;
    // Only archive primary transcripts that are no longer referenced by the
    // current store and still carry the lifecycle marker supplied by the caller.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const transcriptPath = path.join(sessionsDir, entry.name);
      if (referencedTranscriptPaths.has(normalizePathForLifecycleComparison(transcriptPath))) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(transcriptPath);
      } catch {
        continue;
      }
      if (params.nowMs - stat.mtimeMs < params.orphanTranscriptMinAgeMs) {
        continue;
      }
      let content: string;
      try {
        content = await fs.promises.readFile(transcriptPath, "utf-8");
      } catch {
        continue;
      }
      if (!content.includes(params.transcriptContentMarker)) {
        continue;
      }
      const sessionId = entry.name.slice(0, -".jsonl".length);
      archived += archiveSessionTranscripts({
        sessionId,
        storePath: params.storePath,
        sessionFile: transcriptPath,
        reason: "deleted",
        restrictToStoreDir: true,
      }).length;
    }
    return archived;
  });
}

/** Cleans scoped session lifecycle entries and their unreferenced transcript artifacts. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const nowMs = params.nowMs ?? Date.now();
  const storePath = path.resolve(params.storePath);
  const sessionsDir = path.dirname(storePath);
  const removedSessionFiles = new Map<string, string | undefined>();
  const removedTranscriptPaths: Array<{ sessionId: string; transcriptPath: string }> = [];
  const archiveRemovedEntryTranscripts = params.archiveRemovedEntryTranscripts !== false;
  let removedEntries = 0;
  let archivedTranscriptArtifacts = 0;

  await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    // Delete only rows owned by the named lifecycle. Orphan transcript cleanup
    // reacquires this writer lock later so its reference set cannot go stale.
    for (const [sessionKey, entry] of Object.entries(store)) {
      const transcriptPath = resolveLifecycleTranscriptPath({ entry, sessionsDir });
      const matchesLifecycle = sessionKeySegmentStartsWith(sessionKey, sessionKeySegmentPrefix);
      if (
        matchesLifecycle &&
        lifecycleTranscriptIsReclaimable({
          transcriptPath,
          nowMs,
          orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        })
      ) {
        if (archiveRemovedEntryTranscripts) {
          rememberRemovedSessionFile(removedSessionFiles, entry);
          if (entry.sessionId && transcriptPath && fs.existsSync(transcriptPath)) {
            removedTranscriptPaths.push({ sessionId: entry.sessionId, transcriptPath });
          }
        }
        delete store[sessionKey];
        removedEntries += 1;
        continue;
      }
    }

    if (removedEntries === 0) {
      restoreUnchangedSessionStoreCache(storePath, store);
      return;
    }

    const referencedSessionIds = new Set(
      Object.values(store)
        .map((entry) => entry?.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    // Archive only the exact transcript path that passed the age/missing guard.
    // Broader session-id candidate scans can include fresh sibling transcripts.
    for (const { sessionId: removedSessionId, transcriptPath } of removedTranscriptPaths) {
      if (referencedSessionIds.has(removedSessionId)) {
        continue;
      }
      archivedTranscriptArtifacts += archiveExactLifecycleTranscriptPath({
        sessionsDir,
        transcriptPath,
      });
    }
    const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
    await removeRemovedSessionTrajectoryArtifacts({
      removedSessionFiles,
      referencedSessionIds,
      storePath,
      restrictToStoreDir: true,
    });
    await saveSessionStoreUnlocked(storePath, store, { skipMaintenance: true });
  });

  return {
    removedEntries,
    archivedTranscriptArtifacts:
      archivedTranscriptArtifacts +
      (await archiveUnreferencedLifecycleTranscriptArtifacts({
        storePath,
        transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs,
      })),
  };
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
  serializedPromptRefs?: ReadonlyMap<string, SessionSkillPromptRef>;
  cloneSerialized?: string;
  promptBlobs: Iterable<SessionSkillPromptBlobProjection>;
  takeOwnership?: boolean;
}): Promise<void> {
  // Stage the temp as `sessions.json.<pid>.<uuid>.tmp` (not the generic
  // `.fs-safe-replace.*`) so a temp orphaned by a crash between write and rename
  // is identifiable as a session-store temp and reclaimable by cleanup (#56827).
  await writeTextAtomic(params.storePath, params.serialized, {
    durable: false,
    mode: 0o600,
    tempPrefix: path.basename(params.storePath),
    beforeRename: async () => {
      await ensureSessionStorePromptBlobsForPersistence({
        storePath: params.storePath,
        promptBlobs: params.promptBlobs,
      });
    },
  });
  updateSessionStoreWriteCaches({
    storePath: params.storePath,
    store: params.store,
    serialized: params.serialized,
    serializedPromptRefs: params.serializedPromptRefs,
    cloneSerialized: params.cloneSerialized,
    takeOwnership: params.takeOwnership,
  });
}

async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
  skipMaintenance?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  takeCacheOwnership?: boolean;
  returnDetached?: boolean;
  requireWriteSuccess?: boolean;
}): Promise<SessionEntry> {
  const entryUnchanged =
    params.resolved.legacyKeys.length === 0 &&
    sessionEntriesHaveSameSerializedForm(params.resolved.existing, params.next);
  const next = params.takeCacheOwnership ? cloneSessionEntry(params.next) : params.next;
  params.store[params.resolved.normalizedKey] = next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
    skipMaintenance: params.skipMaintenance,
    maintenanceConfig: params.maintenanceConfig,
    skipSerializeForUnchangedStore: entryUnchanged,
    singleEntryPersistence:
      params.resolved.legacyKeys.length === 0 && params.resolved.existing
        ? { sessionKey: params.resolved.normalizedKey, entry: next }
        : undefined,
    takeCacheOwnership: params.takeCacheOwnership,
    requireWriteSuccess: params.requireWriteSuccess,
  });
  return entryUnchanged || params.returnDetached ? cloneSessionEntry(next) : next;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      return null;
    }
    const patch = await update(cloneSessionEntry(existing));
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership ?? true,
      requireWriteSuccess: params.requireWriteSuccess,
      returnDetached: params.takeCacheOwnership !== true,
    });
  });
}

export async function applySessionStoreEntryPatch(params: {
  storePath: string;
  sessionKey: string;
  patch: Partial<SessionEntry>;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, patch } = params;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      return null;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership ?? true,
      returnDetached: params.takeCacheOwnership !== true,
    });
  });
}

type SessionEntryPatchParams = SessionEntryWorkflowOptions & {
  sessionKey: string;
  fallbackEntry?: SessionEntry;
  preserveActivity?: boolean;
  requireWriteSuccess?: boolean;
  replaceEntry?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  update: (
    entry: SessionEntry,
    context: { existingEntry?: SessionEntry },
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

export async function patchSessionEntry(
  params: SessionEntryPatchParams,
): Promise<SessionEntry | null> {
  return (await patchSessionEntryWithKey(params))?.entry ?? null;
}

export async function patchSessionEntryWithKey(
  params: SessionEntryPatchParams,
): Promise<{ sessionKey: string; entry: SessionEntry } | null> {
  const storePath = resolveSessionStorePathForScope(params);
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const existing = resolved.existing ?? params.fallbackEntry;
    if (!existing) {
      return null;
    }
    const patch = await params.update(cloneSessionEntry(existing), {
      existingEntry: resolved.existing ? cloneSessionEntry(resolved.existing) : undefined,
    });
    if (!patch) {
      return { sessionKey: resolved.normalizedKey, entry: existing };
    }
    const next = params.replaceEntry
      ? cloneSessionEntry(patch as SessionEntry)
      : params.preserveActivity
        ? mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
    return {
      sessionKey: resolved.normalizedKey,
      entry: await persistResolvedSessionEntry({
        storePath,
        store,
        resolved,
        next,
        maintenanceConfig: params.maintenanceConfig,
        requireWriteSuccess: params.requireWriteSuccess,
        skipMaintenance: params.skipMaintenance,
        takeCacheOwnership: params.takeCacheOwnership ?? true,
        returnDetached: params.takeCacheOwnership !== true,
      }),
    };
  });
}

export async function upsertSessionEntry(
  params: SessionEntryWorkflowOptions & {
    sessionKey: string;
    entry: SessionEntry;
  },
): Promise<void> {
  const storePath = resolveSessionStorePathForScope(params);
  await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const next = cloneSessionEntry(params.entry);
    await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      takeCacheOwnership: true,
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    const patch = deriveSessionMetaPatch({
      ctx,
      sessionKey: resolved.normalizedKey,
      existing,
      groupResolution: params.groupResolution,
    });
    if (!patch) {
      if (existing && resolved.legacyKeys.length > 0) {
        return await persistResolvedSessionEntry({
          storePath,
          store,
          resolved,
          next: existing,
          takeCacheOwnership: true,
          returnDetached: true,
        });
      }
      await saveSessionStoreUnlocked(storePath, store, {
        activeSessionKey: resolved.normalizedKey,
        skipSerializeForUnchangedStore: true,
      });
      return existing ? cloneSessionEntry(existing) : null;
    }
    if (!existing && !createIfMissing) {
      await saveSessionStoreUnlocked(storePath, store, {
        activeSessionKey: resolved.normalizedKey,
        skipSerializeForUnchangedStore: true,
      });
      return null;
    }
    const next = existing
      ? // Inbound metadata updates must not refresh activity timestamps;
        // idle reset evaluation relies on updatedAt from actual session turns.
        mergeSessionEntryPreserveActivity(existing, patch)
      : mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      takeCacheOwnership: true,
      returnDetached: true,
    });
  });
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: SessionEntry["route"];
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing && !createIfMissing) {
      return null;
    }
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const routeContext = deliveryContextFromChannelRoute(params.route);
    const mergedInput = mergeDeliveryContext(
      routeContext,
      mergeDeliveryContext(explicitContext, inlineContext),
    );
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null && Object.hasOwn(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      routeContext?.channel ||
      routeContext?.to ||
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      route: params.route,
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey: resolved.normalizedKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      route: normalized.route,
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    // Route updates must not refresh activity timestamps; idle/daily reset
    // evaluation relies on updatedAt from actual session turns (#49515).
    const next = mergeSessionEntryPreserveActivity(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      takeCacheOwnership: true,
      returnDetached: true,
    });
  });
}
