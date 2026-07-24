// Doctor-only reader and writer for retired sessions.json stores.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeRestartRecoveryEntryFields } from "../config/sessions/restart-recovery-state.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  hydrateSessionStoreSkillPromptRefs,
  projectSessionStoreForPersistence,
} from "../config/sessions/skill-prompt-blobs.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import {
  applyFileBackedSessionStoreMaintenance,
  type SessionMaintenanceApplyReport,
} from "../config/sessions/store-maintenance-operations.js";
import { collectSessionMaintenancePreserveKeysForStore } from "../config/sessions/store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  pruneStaleModelRunEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "../config/sessions/store-maintenance.js";
import { applySessionStoreMigrations } from "../config/sessions/store-migrations.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  normalizeSessionRuntimeModelFields,
  type SessionEntry,
  type SessionOrigin,
} from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import { isPluginJsonValue, type PluginJsonValue } from "../plugins/host-hook-json.js";
import { normalizeSessionEntrySlotKey } from "../plugins/session-entry-slot-keys.js";
import {
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../sessions/agent-harness-session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  deliveryContextFromChannelRoute,
  isCanonicalSessionDeliveryState,
  mergeDeliveryContext,
  normalizeDeliveryChannelRoute,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import { writeTextAtomic } from "./json-files.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";

export type LegacySessionStoreLoadOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
  hydrateSkillPromptRefs?: boolean;
};

export type LegacySessionStoreSaveOptions = {
  skipMaintenance?: boolean;
  skipSerializeForUnchangedStore?: boolean;
  takeCacheOwnership?: boolean;
  activeSessionKey?: string;
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  singleEntryPersistence?: { sessionKey: string; entry: SessionEntry };
  requireWriteSuccess?: boolean;
};

type LegacySessionStoreUpdateOptions<T> = LegacySessionStoreSaveOptions & {
  reentrant?: boolean;
  skipSaveWhenResult?: (result: T) => boolean;
  resolveSingleEntryPersistence?: (
    result: T,
  ) => { sessionKey: string; entry: SessionEntry } | null | undefined;
};

const log = createSubsystemLogger("sessions/legacy-importer");
const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../gateway/session-archive.runtime.js"),
);
const loadTrajectoryCleanupRuntime = createLazyRuntimeModule(
  () => import("../trajectory/cleanup.js"),
);

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalAttemptCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalStringOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function normalizeRecordKey(value: string): string | undefined {
  const key = value.trim();
  return key.length > 0 ? key : undefined;
}

function normalizeOptionalDeliveryContext(
  value: unknown,
): SessionEntry["pendingFinalDeliveryContext"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext({
    channel: typeof value.channel === "string" ? value.channel : undefined,
    to: typeof value.to === "string" ? value.to : undefined,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    threadId:
      typeof value.threadId === "string" || typeof value.threadId === "number"
        ? value.threadId
        : undefined,
  });
  return normalized?.channel && normalized.to ? normalized : undefined;
}

function sameDeliveryContext(
  left: SessionEntry["pendingFinalDeliveryContext"],
  right: SessionEntry["pendingFinalDeliveryContext"],
): boolean {
  return (
    (left?.channel ?? undefined) === (right?.channel ?? undefined) &&
    (left?.to ?? undefined) === (right?.to ?? undefined) &&
    (left?.accountId ?? undefined) === (right?.accountId ?? undefined) &&
    (left?.threadId ?? undefined) === (right?.threadId ?? undefined)
  );
}

function normalizePendingFinalDeliveryFields(entry: SessionEntry): SessionEntry {
  let next = entry;
  const assign = <K extends keyof SessionEntry>(key: K, value: SessionEntry[K] | undefined) => {
    if (entry[key] === value) {
      return;
    }
    if (next === entry) {
      next = { ...entry };
    }
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  };

  assign("pendingFinalDelivery", entry.pendingFinalDelivery === true ? true : undefined);
  assign("pendingFinalDeliveryText", normalizeOptionalStringOrNull(entry.pendingFinalDeliveryText));
  assign(
    "pendingFinalDeliveryCreatedAt",
    normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryCreatedAt),
  );
  assign(
    "pendingFinalDeliveryLastAttemptAt",
    normalizeOptionalFiniteNumber(entry.pendingFinalDeliveryLastAttemptAt),
  );
  assign(
    "pendingFinalDeliveryAttemptCount",
    normalizeOptionalAttemptCount(entry.pendingFinalDeliveryAttemptCount),
  );
  assign(
    "pendingFinalDeliveryLastError",
    normalizeOptionalStringOrNull(entry.pendingFinalDeliveryLastError),
  );
  const pendingContext = normalizeOptionalDeliveryContext(entry.pendingFinalDeliveryContext);
  if (!sameDeliveryContext(entry.pendingFinalDeliveryContext, pendingContext)) {
    assign("pendingFinalDeliveryContext", pendingContext);
  }
  assign(
    "pendingFinalDeliveryIntentId",
    normalizeOptionalStringOrNull(entry.pendingFinalDeliveryIntentId),
  );
  const restartContext = normalizeOptionalDeliveryContext(entry.restartRecoveryDeliveryContext);
  if (!sameDeliveryContext(entry.restartRecoveryDeliveryContext, restartContext)) {
    assign("restartRecoveryDeliveryContext", restartContext);
  }
  normalizeRestartRecoveryEntryFields(entry, assign);
  return next;
}

function normalizePluginExtensions(entry: SessionEntry): SessionEntry {
  if (entry.pluginExtensions === undefined) {
    return entry;
  }
  if (!isRecord(entry.pluginExtensions)) {
    const next = { ...entry };
    delete next.pluginExtensions;
    return next;
  }
  let changed = false;
  const normalizedExtensions: Record<string, Record<string, PluginJsonValue>> = {};
  for (const [rawPluginId, rawPluginState] of Object.entries(entry.pluginExtensions)) {
    const pluginId = normalizeRecordKey(rawPluginId);
    if (!pluginId || !isRecord(rawPluginState)) {
      changed = true;
      continue;
    }
    changed ||= pluginId !== rawPluginId;
    const normalizedPluginState: Record<string, PluginJsonValue> = {};
    for (const [rawNamespace, rawValue] of Object.entries(rawPluginState)) {
      const namespace = normalizeRecordKey(rawNamespace);
      if (!namespace || !isPluginJsonValue(rawValue)) {
        changed = true;
        continue;
      }
      changed ||= namespace !== rawNamespace;
      normalizedPluginState[namespace] = rawValue;
    }
    if (Object.keys(normalizedPluginState).length === 0) {
      changed = true;
      continue;
    }
    normalizedExtensions[pluginId] = normalizedPluginState;
  }
  if (!changed) {
    return entry;
  }
  const next = { ...entry };
  if (Object.keys(normalizedExtensions).length > 0) {
    next.pluginExtensions = normalizedExtensions;
  } else {
    delete next.pluginExtensions;
  }
  return next;
}

function normalizePluginExtensionSlotKeys(entry: SessionEntry): SessionEntry {
  if (entry.pluginExtensionSlotKeys === undefined) {
    return entry;
  }
  if (!isRecord(entry.pluginExtensionSlotKeys)) {
    const next = { ...entry };
    delete next.pluginExtensionSlotKeys;
    return next;
  }
  let changed = false;
  const normalizedSlotKeys: Record<string, Record<string, string>> = {};
  for (const [rawPluginId, rawPluginSlots] of Object.entries(entry.pluginExtensionSlotKeys)) {
    const pluginId = normalizeRecordKey(rawPluginId);
    if (!pluginId || !isRecord(rawPluginSlots)) {
      changed = true;
      continue;
    }
    changed ||= pluginId !== rawPluginId;
    const normalizedPluginSlots: Record<string, string> = {};
    for (const [rawNamespace, rawSlotKey] of Object.entries(rawPluginSlots)) {
      const namespace = normalizeRecordKey(rawNamespace);
      const slotKey = normalizeSessionEntrySlotKey(rawSlotKey);
      if (!namespace || !slotKey.ok) {
        changed = true;
        continue;
      }
      changed ||= namespace !== rawNamespace || slotKey.key !== rawSlotKey;
      normalizedPluginSlots[namespace] = slotKey.key;
    }
    if (Object.keys(normalizedPluginSlots).length === 0) {
      changed = true;
      continue;
    }
    normalizedSlotKeys[pluginId] = normalizedPluginSlots;
  }
  if (!changed) {
    return entry;
  }
  const next = { ...entry };
  if (Object.keys(normalizedSlotKeys).length > 0) {
    next.pluginExtensionSlotKeys = normalizedSlotKeys;
  } else {
    delete next.pluginExtensionSlotKeys;
  }
  return next;
}

function stripPersistedSkillsCache(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot || snapshot.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...rest } = snapshot;
  return { ...entry, skillsSnapshot: rest };
}

function normalizeLegacySessionStore(store: Record<string, SessionEntry>): void {
  applySessionStoreMigrations(store);
  for (const [key, entry] of Object.entries(store)) {
    const modelSelectionLocked = isRecord(entry) && entry.modelSelectionLocked === true;
    const shaped = normalizePersistedSessionEntryShape(entry);
    if (!shaped) {
      if (modelSelectionLocked) {
        throw new Error(`Invalid model-selection-locked session entry: ${key}`);
      }
      delete store[key];
      continue;
    }
    const runtimeFields = normalizeSessionRuntimeModelFields(shaped);
    if (modelSelectionLocked && runtimeFields !== shaped) {
      throw new Error(`Invalid model-selection-locked session entry: ${key}`);
    }
    store[key] = stripPersistedSkillsCache(
      normalizePluginExtensionSlotKeys(
        normalizePluginExtensions(
          normalizePendingFinalDeliveryFields(
            normalizeLegacySessionEntryDelivery(modelSelectionLocked ? shaped : runtimeFields),
          ),
        ),
      ),
    );
  }
  const harnessError = resolveAgentHarnessSessionStoreError(store);
  if (harnessError) {
    throw new Error(harnessError);
  }
}

export function loadLegacySessionStore(
  storePath: string,
  options: LegacySessionStoreLoadOptions = {},
): Record<string, SessionEntry> {
  const { store } = readSessionStoreJson5(storePath);
  if (options.hydrateSkillPromptRefs !== false) {
    hydrateSessionStoreSkillPromptRefs({ storePath, store });
  }
  const sessionStore = store as Record<string, SessionEntry>;
  normalizeLegacySessionStore(sessionStore);
  if (options.runMaintenance) {
    const maintenance = options.maintenanceConfig ?? resolveMaintenanceConfig();
    const beforeCount = Object.keys(sessionStore).length;
    if (maintenance.mode === "enforce") {
      const preserveSessionKeys = collectSessionMaintenancePreserveKeysForStore({
        storePath,
        store: sessionStore,
      });
      if (shouldRunModelRunPrune({ maintenance, entryCount: beforeCount })) {
        pruneStaleModelRunEntries(sessionStore, maintenance.modelRunPruneAfterMs, {
          log: false,
          preserveKeys: preserveSessionKeys,
        });
      }
      if (Object.keys(sessionStore).length > maintenance.maxEntries) {
        pruneStaleEntries(sessionStore, maintenance.pruneAfterMs, {
          log: false,
          preserveKeys: preserveSessionKeys,
        });
        if (
          shouldRunSessionEntryMaintenance({
            entryCount: Object.keys(sessionStore).length,
            maxEntries: maintenance.maxEntries,
          })
        ) {
          capEntryCount(sessionStore, maintenance.maxEntries, {
            log: false,
            preserveKeys: preserveSessionKeys,
          });
        }
      }
    }
  }
  return sessionStore;
}

function snapshotLockedEntries(
  store: Record<string, SessionEntry>,
): ReadonlyMap<string, SessionEntry> {
  return new Map(
    Object.entries(store).flatMap(([sessionKey, entry]) =>
      isValidAgentHarnessSessionStoreEntry(sessionKey, entry)
        ? [[sessionKey, structuredClone(entry)] as const]
        : [],
    ),
  );
}

function assertLegacySessionStoreWriteIsValid(params: {
  lockedEntriesBefore: ReadonlyMap<string, SessionEntry>;
  store: Record<string, SessionEntry>;
}): void {
  const transitionError = resolveAgentHarnessSessionStoreTransitionError({
    before: params.lockedEntriesBefore,
    store: params.store,
  });
  if (transitionError) {
    throw new Error(transitionError);
  }
  const storeError = resolveAgentHarnessSessionStoreError(params.store);
  if (storeError) {
    throw new Error(storeError);
  }
}

function stripRuntimeOnlySkillState(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [
      sessionKey,
      stripPersistedSkillsCache(entry),
    ]),
  );
}

async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted";
  restrictToStoreDir: true;
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

async function persistLegacySessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const persisted = projectSessionStoreForPersistence({
    storePath,
    store: stripRuntimeOnlySkillState(store),
  });
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await writeTextAtomic(storePath, JSON.stringify(persisted.store, null, 2), {
    beforeRename: async () => {
      await ensureSessionStorePromptBlobsForPersistence({
        storePath,
        promptBlobs: persisted.promptBlobs.values(),
      });
    },
    durable: true,
    mode: 0o600,
    tempPrefix: path.basename(storePath),
    trailingNewline: true,
  });
}

async function writeLegacySessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  lockedEntriesBefore: ReadonlyMap<string, SessionEntry>,
  options: LegacySessionStoreSaveOptions,
): Promise<void> {
  normalizeLegacySessionStore(store);
  assertLegacySessionStoreWriteIsValid({ lockedEntriesBefore, store });
  if (!options.skipMaintenance) {
    await applyFileBackedSessionStoreMaintenance({
      storePath,
      store,
      activeSessionKey: options.activeSessionKey,
      onWarn: options.onWarn,
      onMaintenanceApplied: options.onMaintenanceApplied,
      maintenanceOverride: options.maintenanceOverride,
      maintenanceConfig: options.maintenanceConfig,
      log,
      commitReducedStore: () => persistLegacySessionStore(storePath, store),
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
  }
  assertLegacySessionStoreWriteIsValid({ lockedEntriesBefore, store });
  await persistLegacySessionStore(storePath, store);
}

export async function saveLegacySessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  options: LegacySessionStoreSaveOptions = {},
): Promise<void> {
  await runExclusiveSessionStoreWrite(storePath, async () => {
    const currentStore = loadLegacySessionStore(storePath);
    await writeLegacySessionStoreUnlocked(
      storePath,
      store,
      snapshotLockedEntries(currentStore),
      options,
    );
  });
}

export async function updateLegacySessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  options: LegacySessionStoreUpdateOptions<T> = {},
): Promise<T> {
  return await runExclusiveSessionStoreWrite(
    storePath,
    async () => {
      const store = loadLegacySessionStore(storePath);
      const lockedEntriesBefore = snapshotLockedEntries(store);
      const result = await mutator(store);
      if (!options.skipSaveWhenResult?.(result)) {
        await writeLegacySessionStoreUnlocked(storePath, store, lockedEntriesBefore, options);
      }
      return result;
    },
    { reentrant: options.reentrant },
  );
}

type LegacySessionDeliveryEntry = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

const LEGACY_SESSION_DELIVERY_KEYS = [
  "route",
  "deliveryContext",
  "origin",
  "channel",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
] as const;

function isInternalContext(context?: DeliveryContext): boolean {
  return Boolean(
    context?.channel &&
    (context.channel === INTERNAL_MESSAGE_CHANNEL || isInternalNonDeliveryChannel(context.channel)),
  );
}

function hasExternalTarget(context?: DeliveryContext): boolean {
  return Boolean(
    context?.channel &&
    context.channel !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(context.channel) &&
    context.to,
  );
}

function mergeExternalOverInternal(
  external?: DeliveryContext,
  internal?: DeliveryContext,
): DeliveryContext | undefined {
  return normalizeDeliveryContext({
    channel: external?.channel,
    to: external?.to,
    accountId: external?.accountId ?? internal?.accountId,
    threadId: external?.threadId ?? internal?.threadId,
  });
}

/** Canonicalizes file-era delivery fields before doctor imports a row into SQLite. */
export function normalizeLegacySessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const legacy = entry as LegacySessionDeliveryEntry;
  const hasLegacyFields = LEGACY_SESSION_DELIVERY_KEYS.some((key) => key in legacy);
  if (isCanonicalSessionDeliveryState(entry.delivery) && !hasLegacyFields) {
    return entry;
  }

  const route = normalizeDeliveryChannelRoute(legacy.route);
  const routeContext = deliveryContextFromChannelRoute(route);
  const explicitContext = normalizeDeliveryContext(legacy.deliveryContext);
  const lastChannel = normalizeDeliveryContext({ channel: legacy.lastChannel })?.channel;
  const storedChannel = normalizeDeliveryContext({ channel: legacy.channel })?.channel;
  const originChannel = normalizeDeliveryContext({ channel: legacy.origin?.provider })?.channel;
  const normalizedLastFields = normalizeDeliveryContext({
    to: legacy.lastTo,
    accountId: legacy.lastAccountId,
    threadId: legacy.lastThreadId,
  });
  const hasNormalizedLastFields = Boolean(
    normalizedLastFields?.to ||
    normalizedLastFields?.accountId ||
    normalizedLastFields?.threadId != null,
  );
  const lastCandidate = normalizeDeliveryContext({
    channel:
      lastChannel ?? (hasNormalizedLastFields ? (storedChannel ?? originChannel) : undefined),
    to: normalizedLastFields?.to,
    accountId: normalizedLastFields?.accountId,
    threadId: normalizedLastFields?.threadId,
  });
  const lastContext =
    isInternalContext(lastCandidate) ||
    hasExternalTarget(lastCandidate) ||
    (lastChannel != null && lastCandidate?.channel != null) ||
    (lastCandidate?.channel && lastCandidate.channel === explicitContext?.channel)
      ? lastCandidate
      : undefined;
  const channelContext = normalizeDeliveryContext({ channel: legacy.channel });
  const originContext = normalizeDeliveryContext({
    channel: legacy.origin?.provider,
    to: legacy.origin?.to,
    accountId: legacy.origin?.accountId,
    threadId: legacy.origin?.threadId,
  });
  const fallbackContext = mergeDeliveryContext(
    lastContext,
    mergeDeliveryContext(explicitContext, mergeDeliveryContext(channelContext, originContext)),
  );
  const internalFallbackContext = isInternalContext(routeContext)
    ? mergeDeliveryContext(routeContext, lastContext)
    : isInternalContext(lastContext)
      ? lastContext
      : isInternalContext(channelContext)
        ? mergeDeliveryContext(channelContext, lastContext)
        : undefined;
  const hasInternalFallback =
    internalFallbackContext !== undefined && hasExternalTarget(explicitContext);
  const context = hasInternalFallback
    ? mergeExternalOverInternal(explicitContext, internalFallbackContext)
    : mergeDeliveryContext(routeContext, fallbackContext);
  const migratedDelivery = normalizeSessionDeliveryState({
    route: hasInternalFallback ? undefined : route,
    context,
    origin: legacy.origin,
  });
  const recoverLegacyDelivery =
    isCanonicalSessionDeliveryState(entry.delivery) &&
    ((entry.delivery.kind === "none" && migratedDelivery.kind !== "none") ||
      (entry.delivery.kind === "internal" && migratedDelivery.kind === "external"));
  const delivery =
    isCanonicalSessionDeliveryState(entry.delivery) && !recoverLegacyDelivery
      ? entry.delivery
      : migratedDelivery;
  const next = { ...entry, delivery } as LegacySessionDeliveryEntry;
  const legacyChatType = legacy.origin?.chatType;
  if (
    next.chatType == null &&
    (legacyChatType === "direct" || legacyChatType === "group" || legacyChatType === "channel")
  ) {
    next.chatType = legacyChatType;
  }
  for (const key of LEGACY_SESSION_DELIVERY_KEYS) {
    delete next[key];
  }
  return next;
}
