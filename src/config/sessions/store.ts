import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { getRuntimeConfig } from "../io.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { resolveStorePath } from "./paths.js";
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
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import {
  loadSessionStore,
  normalizeSessionStore,
  readSessionEntries,
  readSessionEntry,
} from "./store-load.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneQuotaSuspensions,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type QuotaSuspensionMaintenanceResult,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
  type SessionSkillPromptRef,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
  getSessionStoreWriterQueueSizeForTest,
} from "./store-writer-state.js";
export { withSessionStoreWriterForTest } from "./store-writer.js";
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

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let trajectoryCleanupRuntimePromise: Promise<typeof import("../../trajectory/cleanup.js")> | null =
  null;
const writerStoreFileStats = new WeakMap<
  Record<string, SessionEntry>,
  ReturnType<typeof getFileStatSnapshot> | null
>();

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function loadTrajectoryCleanupRuntime() {
  trajectoryCleanupRuntimePromise ??= import("../../trajectory/cleanup.js");
  return trajectoryCleanupRuntimePromise;
}

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

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  getSessionStoreCacheVersion,
  pruneStaleEntries,
  resolveMaintenanceConfig,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Caller already proved the store serialization is unchanged unless maintenance mutates it. */
  skipSerializeForUnchangedStore?: boolean;
  /** Internal hot paths can hand writer-owned stores to the cache after persistence. */
  takeCacheOwnership?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
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
};

type UpdateSessionStoreOptions<T> = SaveSessionStoreOptions & {
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

type SessionEntryWorkflowOptions = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  storePath?: string;
};

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return cloneSessionStoreRecord({ entry }).entry;
}

function resolveSessionWorkflowStorePath(
  options: SessionEntryWorkflowOptions & { sessionKey?: string },
): string {
  if (options.storePath) {
    return options.storePath;
  }
  const agentId = options.agentId ?? resolveAgentIdFromSessionKey(options.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: options.env,
  });
}

export function getSessionEntry(
  options: SessionEntryWorkflowOptions & { sessionKey: string },
): SessionEntry | undefined {
  const entry = readSessionEntry(resolveSessionWorkflowStorePath(options), options.sessionKey, {
    hydrateSkillPromptRefs: options.hydrateSkillPromptRefs,
  }) as SessionEntry | undefined;
  return entry ? cloneSessionEntry(entry) : undefined;
}

export function listSessionEntries(
  options: SessionEntryWorkflowOptions = {},
): Array<{ sessionKey: string; entry: SessionEntry }> {
  return readSessionEntries(resolveSessionWorkflowStorePath(options)).map(
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

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.hasOwn(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.hasOwn(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, entry.acp);
    }
  }
  return snapshot;
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
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
    // Resolve maintenance config once (avoids repeated getRuntimeConfig() calls).
    const maintenance = opts?.maintenanceConfig
      ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
      : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;
    const forceMaintenance = opts?.maintenanceOverride !== undefined;
    const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
      entryCount: beforeCount,
      maxEntries: maintenance.maxEntries,
      force: forceMaintenance,
    });

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey && shouldRunEntryMaintenance) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: true,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned: 0,
        capped: 0,
        diskBudget,
      });
    } else {
      const preserveSessionKeys = collectSessionMaintenancePreserveKeys([opts?.activeSessionKey]);
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
        preserveKeys: preserveSessionKeys,
      });
      const countAfterPrune = Object.keys(store).length;
      const shouldRunCapMaintenance =
        forceMaintenance ||
        shouldRunSessionEntryMaintenance({
          entryCount: countAfterPrune,
          maxEntries: maintenance.maxEntries,
        });
      const capped = shouldRunCapMaintenance
        ? capEntryCount(store, maintenance.maxEntries, {
            onCapped: ({ entry }) => {
              rememberRemovedSessionFile(removedSessionFiles, entry);
            },
            preserveKeys: preserveSessionKeys,
          })
        : 0;
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
        removedSessionFiles,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (removedSessionFiles.size > 0) {
        const { removeRemovedSessionTrajectoryArtifacts } = await loadTrajectoryCleanupRuntime();
        await removeRemovedSessionTrajectoryArtifacts({
          removedSessionFiles,
          referencedSessionIds,
          storePath,
          restrictToStoreDir: true,
        });
      }
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        await cleanupArchivedSessionTranscripts({
          directories: targetDirs,
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
        if (maintenance.resetArchiveRetentionMs != null) {
          await cleanupArchivedSessionTranscripts({
            directories: targetDirs,
            olderThanMs: maintenance.resetArchiveRetentionMs,
            reason: "reset",
          });
        }
      }

      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        preserveKeys: preserveSessionKeys,
        maintenance,
        warnOnly: false,
        log,
      });
      maintenanceChangedStore = pruned > 0 || capped > 0 || (diskBudget?.removedEntries ?? 0) > 0;
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned,
        capped,
        diskBudget,
      });
    }
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
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed - skip this save. The writer queue ensures
        // the next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
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
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
    const result = await mutator(store);
    if (opts?.skipSaveWhenResult?.(result)) {
      restoreUnchangedSessionStoreCache(storePath, store);
      return result;
    }
    preserveExistingAcpMetadata({
      previousAcpByKey,
      nextStore: store,
      allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
    });
    await saveSessionStoreUnlocked(storePath, store, {
      ...opts,
      singleEntryPersistence: opts?.resolveSingleEntryPersistence?.(result) ?? undefined,
    });
    return result;
  });
}

export async function runQuotaSuspensionMaintenance(params: {
  storePath: string;
  now?: number;
  ttlMs?: number;
  log?: boolean;
}): Promise<QuotaSuspensionMaintenanceResult> {
  if (!fs.existsSync(params.storePath)) {
    return { resumed: [], cleared: 0 };
  }
  return await updateSessionStore(
    params.storePath,
    (store) =>
      pruneQuotaSuspensions({
        store,
        now: params.now ?? Date.now(),
        ttlMs: params.ttlMs,
        log: params.log,
      }),
    { skipMaintenance: true },
  );
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
  previousAcpByKey?: Map<string, NonNullable<SessionEntry["acp"]>>;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  returnDetached?: boolean;
}): Promise<SessionEntry> {
  const entryUnchanged =
    params.resolved.legacyKeys.length === 0 &&
    sessionEntriesHaveSameSerializedForm(params.resolved.existing, params.next);
  const next = params.takeCacheOwnership ? cloneSessionEntry(params.next) : params.next;
  params.store[params.resolved.normalizedKey] = next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  if (params.previousAcpByKey) {
    preserveExistingAcpMetadata({
      previousAcpByKey: params.previousAcpByKey,
      nextStore: params.store,
    });
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
    skipMaintenance: params.skipMaintenance,
    skipSerializeForUnchangedStore: entryUnchanged,
    singleEntryPersistence:
      params.resolved.legacyKeys.length === 0 && params.resolved.existing
        ? { sessionKey: params.resolved.normalizedKey, entry: next }
        : undefined,
    takeCacheOwnership: params.takeCacheOwnership,
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

export async function patchSessionEntry(
  params: SessionEntryWorkflowOptions & {
    sessionKey: string;
    fallbackEntry?: SessionEntry;
    preserveActivity?: boolean;
    replaceEntry?: boolean;
    update: (
      entry: SessionEntry,
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  },
): Promise<SessionEntry | null> {
  const storePath = resolveSessionWorkflowStorePath(params);
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const existing = resolved.existing ?? params.fallbackEntry;
    if (!existing) {
      return null;
    }
    const patch = await params.update(cloneSessionEntry(existing));
    if (!patch) {
      return existing;
    }
    const next = params.replaceEntry
      ? cloneSessionEntry(patch as SessionEntry)
      : params.preserveActivity
        ? mergeSessionEntryPreserveActivity(existing, patch)
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

export async function upsertSessionEntry(
  params: SessionEntryWorkflowOptions & {
    sessionKey: string;
    entry: SessionEntry;
    allowDropAcpMeta?: boolean;
  },
): Promise<void> {
  const storePath = resolveSessionWorkflowStorePath(params);
  await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const next = cloneSessionEntry(params.entry);
    if (!params.allowDropAcpMeta && resolved.existing?.acp && !next.acp) {
      next.acp = resolved.existing.acp;
    }
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
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
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
          previousAcpByKey,
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
      previousAcpByKey,
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
