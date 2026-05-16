import fs from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPluginJsonValue, type PluginJsonValue } from "../../plugins/host-hook-json.js";
import { normalizeSessionEntrySlotKey } from "../../plugins/session-entry-slot-keys.js";
import {
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  cloneSessionStoreRecord,
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { normalizePersistedSessionEntryShape } from "./store-entry-shape.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
};

const log = createSubsystemLogger("sessions/store");

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalAttemptCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  return undefined;
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
  const pendingFinalDeliveryContext = normalizeOptionalDeliveryContext(
    entry.pendingFinalDeliveryContext,
  );
  if (!sameDeliveryContext(entry.pendingFinalDeliveryContext, pendingFinalDeliveryContext)) {
    assign("pendingFinalDeliveryContext", pendingFinalDeliveryContext);
  }
  assign(
    "pendingFinalDeliveryIntentId",
    normalizeOptionalStringOrNull(entry.pendingFinalDeliveryIntentId),
  );

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
    if (pluginId !== rawPluginId) {
      changed = true;
    }
    const normalizedPluginState: Record<string, PluginJsonValue> = {};
    for (const [rawNamespace, rawValue] of Object.entries(rawPluginState)) {
      const namespace = normalizeRecordKey(rawNamespace);
      if (!namespace || !isPluginJsonValue(rawValue)) {
        changed = true;
        continue;
      }
      if (namespace !== rawNamespace) {
        changed = true;
      }
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
    if (pluginId !== rawPluginId) {
      changed = true;
    }
    const normalizedPluginSlots: Record<string, string> = {};
    for (const [rawNamespace, rawSlotKey] of Object.entries(rawPluginSlots)) {
      const namespace = normalizeRecordKey(rawNamespace);
      const slotKey = normalizeSessionEntrySlotKey(rawSlotKey);
      if (!namespace || !slotKey.ok) {
        changed = true;
        continue;
      }
      if (namespace !== rawNamespace || slotKey.key !== rawSlotKey) {
        changed = true;
      }
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

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

// resolvedSkills carries the full parsed Skill[] (including each SKILL.md body)
// and is only used as an in-turn cache by the runtime — see
// src/agents/pi-embedded-runner/skills-runtime.ts. Persisting it bloats
// sessions.json by orders of magnitude when many sessions are active. Strip
// it from every entry that flows through normalize, so neither the in-memory
// store reloaded from disk nor the JSON serialized back to disk carries it.
function stripPersistedSkillsCache(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot || snapshot.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...rest } = snapshot;
  return { ...entry, skillsSnapshot: rest };
}

export function normalizeSessionStore(store: Record<string, SessionEntry>): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    const shaped = normalizePersistedSessionEntryShape(entry);
    if (!shaped) {
      delete store[key];
      changed = true;
      continue;
    }
    const normalized = stripPersistedSkillsCache(
      normalizePluginExtensionSlotKeys(
        normalizePluginExtensions(
          normalizePendingFinalDeliveryFields(
            normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(shaped)),
          ),
        ),
      ),
    );
    if (normalized !== entry) {
      store[key] = normalized;
      changed = true;
    }
  }
  return changed;
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
      clone: opts.clone,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  const migrated = applySessionStoreMigrations(store);
  const normalized = normalizeSessionStore(store);
  if (migrated || normalized) {
    serializedFromDisk = undefined;
  }
  if (opts.runMaintenance) {
    const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfig();
    const beforeCount = Object.keys(store).length;
    let pruned = 0;
    let capped = 0;
    if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
      const preserveSessionKeys = collectSessionMaintenancePreserveKeys();
      pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        log: false,
        preserveKeys: preserveSessionKeys,
      });
      const countAfterPrune = Object.keys(store).length;
      capped = shouldRunSessionEntryMaintenance({
        entryCount: countAfterPrune,
        maxEntries: maintenance.maxEntries,
      })
        ? capEntryCount(store, maintenance.maxEntries, {
            log: false,
            preserveKeys: preserveSessionKeys,
          })
        : 0;
    }
    const afterCount = Object.keys(store).length;
    if (pruned > 0 || capped > 0) {
      serializedFromDisk = undefined;
      log.info("applied load-time maintenance to session store", {
        storePath,
        before: beforeCount,
        after: afterCount,
        pruned,
        capped,
        maxEntries: maintenance.maxEntries,
      });
    }
  }

  setSerializedSessionStore(storePath, serializedFromDisk);

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return opts.clone === false ? store : cloneSessionStoreRecord(store, serializedFromDisk);
}
