/** Shared predicates and mutations for plugin host-owned session-state cleanup. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import { normalizeSessionEntrySlotKey } from "../../plugins/session-entry-slot-keys.js";
import type { SessionEntry } from "./types.js";

/** Cleanup variants owned by plugin host lifecycle paths. */
type PluginHostSessionCleanupMode = "plugin-owned-state" | "promoted-slots";

export type PluginHostSessionCleanupStoreParams = {
  /** Agent that owns the resolved session store target. */
  agentId?: string;
  /** Cleanup mode chosen by the plugin host lifecycle reason. */
  mode: PluginHostSessionCleanupMode;
  /** Plugin owner to clear. Omit only for session-scoped all-plugin cleanup. */
  pluginId?: string;
  /** Optional canonical key, alias, or runtime session id filter. */
  sessionKey?: string;
  /** Promoted SessionEntry slots declared by the plugin registry. */
  sessionEntrySlotKeys?: ReadonlySet<string>;
  /** Locked-harness ids whose sessions this cleanup must leave untouched. */
  preserveLockedHarnessIds?: ReadonlySet<string>;
  /** Per-store file-backed transaction boundary. */
  storePath: string;
  /** Cancels the cleanup before persistence when host lifecycle state changes. */
  shouldCleanup?: () => boolean;
};

function collectStoredSessionEntrySlotKeys(entry: SessionEntry, pluginId?: string): Set<string> {
  const slotKeys = new Set<string>();
  const storedSlotKeys = entry.pluginExtensionSlotKeys;
  if (!storedSlotKeys) {
    return slotKeys;
  }
  const records =
    pluginId === undefined
      ? Object.values(storedSlotKeys)
      : storedSlotKeys[pluginId]
        ? [storedSlotKeys[pluginId]]
        : [];
  for (const record of records) {
    for (const slotKey of Object.values(record)) {
      const normalized = normalizeSessionEntrySlotKey(slotKey);
      if (normalized.ok) {
        slotKeys.add(normalized.key);
      }
    }
  }
  return slotKeys;
}

function collectPromotedSessionEntrySlotKeys(
  entry: SessionEntry,
  pluginId?: string,
  sessionEntrySlotKeys?: ReadonlySet<string>,
): Set<string> {
  const slotKeys = collectStoredSessionEntrySlotKeys(entry, pluginId);
  for (const slotKey of sessionEntrySlotKeys ?? []) {
    slotKeys.add(slotKey);
  }
  return slotKeys;
}

function clearPromotedSessionEntrySlots(
  entry: SessionEntry,
  pluginId?: string,
  sessionEntrySlotKeys?: ReadonlySet<string>,
  options: { includeStoredSlotKeys?: boolean; pruneSlotOwnership?: boolean } = {},
): void {
  const slotKeys =
    options.includeStoredSlotKeys === false && sessionEntrySlotKeys
      ? new Set(sessionEntrySlotKeys)
      : collectPromotedSessionEntrySlotKeys(entry, pluginId, sessionEntrySlotKeys);
  const entryRecord = entry as Record<string, unknown>;
  for (const slotKey of slotKeys) {
    delete entryRecord[slotKey];
  }
  if (!options.pruneSlotOwnership || !entry.pluginExtensionSlotKeys) {
    return;
  }
  // Restart cleanup prunes only ownership for slot keys that disappeared from the new registry.
  const pruneRecord = (record: Record<string, string>): void => {
    for (const [namespace, slotKey] of Object.entries(record)) {
      const normalized = normalizeSessionEntrySlotKey(slotKey);
      if (normalized.ok && slotKeys.has(normalized.key)) {
        delete record[namespace];
      }
    }
  };
  if (pluginId) {
    const record = entry.pluginExtensionSlotKeys[pluginId];
    if (record) {
      pruneRecord(record);
      if (Object.keys(record).length === 0) {
        delete entry.pluginExtensionSlotKeys[pluginId];
      }
    }
  } else {
    for (const record of Object.values(entry.pluginExtensionSlotKeys)) {
      pruneRecord(record);
    }
    for (const [ownerPluginId, record] of Object.entries(entry.pluginExtensionSlotKeys)) {
      if (Object.keys(record).length === 0) {
        delete entry.pluginExtensionSlotKeys[ownerPluginId];
      }
    }
  }
  if (Object.keys(entry.pluginExtensionSlotKeys).length === 0) {
    delete entry.pluginExtensionSlotKeys;
  }
}

/** Clears plugin-owned extension state from one session entry. */
export function clearPluginOwnedSessionState(
  entry: SessionEntry,
  pluginId?: string,
  sessionEntrySlotKeys?: ReadonlySet<string>,
): void {
  clearPromotedSessionEntrySlots(entry, pluginId, sessionEntrySlotKeys);
  if (!pluginId) {
    delete entry.pluginExtensions;
    delete entry.pluginExtensionSlotKeys;
    delete entry.pluginNextTurnInjections;
    return;
  }
  if (entry.pluginExtensions) {
    delete entry.pluginExtensions[pluginId];
    if (Object.keys(entry.pluginExtensions).length === 0) {
      delete entry.pluginExtensions;
    }
  }
  if (entry.pluginExtensionSlotKeys) {
    delete entry.pluginExtensionSlotKeys[pluginId];
    if (Object.keys(entry.pluginExtensionSlotKeys).length === 0) {
      delete entry.pluginExtensionSlotKeys;
    }
  }
  if (entry.pluginNextTurnInjections) {
    delete entry.pluginNextTurnInjections[pluginId];
    if (Object.keys(entry.pluginNextTurnInjections).length === 0) {
      delete entry.pluginNextTurnInjections;
    }
  }
}

function hasPromotedSessionEntrySlot(
  entry: SessionEntry,
  pluginId?: string,
  sessionEntrySlotKeys?: ReadonlySet<string>,
): boolean {
  const slotKeys = collectPromotedSessionEntrySlotKeys(entry, pluginId, sessionEntrySlotKeys);
  if (slotKeys.size === 0) {
    return false;
  }
  const entryRecord = entry as Record<string, unknown>;
  for (const slotKey of slotKeys) {
    if (Object.hasOwn(entryRecord, slotKey)) {
      return true;
    }
  }
  return false;
}

function hasPluginOwnedSessionState(
  entry: SessionEntry,
  pluginId?: string,
  sessionEntrySlotKeys?: ReadonlySet<string>,
): boolean {
  if (hasPromotedSessionEntrySlot(entry, pluginId, sessionEntrySlotKeys)) {
    return true;
  }
  if (!pluginId) {
    return Boolean(
      entry.pluginExtensions || entry.pluginExtensionSlotKeys || entry.pluginNextTurnInjections,
    );
  }
  return Boolean(
    entry.pluginExtensions?.[pluginId] ||
    entry.pluginExtensionSlotKeys?.[pluginId] ||
    entry.pluginNextTurnInjections?.[pluginId],
  );
}

export function matchesPluginHostCleanupSession(
  entryKey: string,
  entry: SessionEntry,
  sessionKey?: string,
): boolean {
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalizedSessionKey) {
    return true;
  }
  return (
    normalizeLowercaseStringOrEmpty(entryKey) === normalizedSessionKey ||
    normalizeLowercaseStringOrEmpty(entry.sessionId) === normalizedSessionKey
  );
}

export function shouldSkipPluginHostCleanupStore(
  params: PluginHostSessionCleanupStoreParams,
): boolean {
  if (!params.pluginId && !params.sessionKey) {
    return true;
  }
  return params.mode === "promoted-slots" && (params.sessionEntrySlotKeys?.size ?? 0) === 0;
}

export function hasPluginHostCleanupTarget(
  entry: SessionEntry,
  params: PluginHostSessionCleanupStoreParams,
): boolean {
  if (params.mode === "promoted-slots") {
    return hasPromotedSessionEntrySlot(entry, params.pluginId, params.sessionEntrySlotKeys);
  }
  return hasPluginOwnedSessionState(entry, params.pluginId, params.sessionEntrySlotKeys);
}

export function isLockedHarnessSessionOwnedByPlugin(
  entry: SessionEntry,
  preserveLockedHarnessIds: ReadonlySet<string> | undefined,
): boolean {
  if (entry.modelSelectionLocked !== true || !preserveLockedHarnessIds?.size) {
    return false;
  }
  const harnessId = normalizeOptionalAgentRuntimeId(entry.agentHarnessId);
  return harnessId !== undefined && preserveLockedHarnessIds.has(harnessId);
}

export function clearPluginHostCleanupTarget(
  entry: SessionEntry,
  params: PluginHostSessionCleanupStoreParams,
): void {
  if (params.mode === "promoted-slots") {
    clearPromotedSessionEntrySlots(entry, params.pluginId, params.sessionEntrySlotKeys, {
      includeStoredSlotKeys: false,
      pruneSlotOwnership: true,
    });
    return;
  }
  clearPluginOwnedSessionState(entry, params.pluginId, params.sessionEntrySlotKeys);
}
