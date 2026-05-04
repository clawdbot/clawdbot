import fs from "node:fs";
import { getRuntimeConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import {
  cleanupPluginSessionSchedulerJobs,
  clearPluginRunContext,
  makePluginSessionSchedulerJobKey,
} from "./host-hook-runtime.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";

export type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

export type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
};

function shouldCleanPlugin(pluginId: string, filterPluginId?: string): boolean {
  return !filterPluginId || pluginId === filterPluginId;
}

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
    if (Object.prototype.hasOwnProperty.call(entryRecord, slotKey)) {
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

function matchesCleanupSession(
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

async function clearPluginOwnedSessionStores(params: {
  cfg: OpenClawConfig;
  pluginId?: string;
  sessionKey?: string;
  sessionEntrySlotKeys?: ReadonlySet<string>;
}): Promise<number> {
  if (!params.pluginId && !params.sessionKey) {
    return 0;
  }
  const storePaths = new Set(
    resolveAllAgentSessionStoreTargetsSync(params.cfg)
      .map((target) => target.storePath)
      .filter((storePath) => fs.existsSync(storePath)),
  );
  let cleared = 0;
  for (const storePath of storePaths) {
    cleared += await updateSessionStore(storePath, (store) => {
      let clearedInStore = 0;
      const now = Date.now();
      for (const [entryKey, entry] of Object.entries(store)) {
        if (
          !matchesCleanupSession(entryKey, entry, params.sessionKey) ||
          !hasPluginOwnedSessionState(entry, params.pluginId, params.sessionEntrySlotKeys)
        ) {
          continue;
        }
        clearPluginOwnedSessionState(entry, params.pluginId, params.sessionEntrySlotKeys);
        entry.updatedAt = now;
        clearedInStore += 1;
      }
      return clearedInStore;
    });
  }
  return cleared;
}

async function clearPromotedSessionEntrySlotStores(params: {
  cfg: OpenClawConfig;
  pluginId?: string;
  sessionKey?: string;
  sessionEntrySlotKeys: ReadonlySet<string>;
}): Promise<number> {
  if ((!params.pluginId && !params.sessionKey) || params.sessionEntrySlotKeys.size === 0) {
    return 0;
  }
  const storePaths = new Set(
    resolveAllAgentSessionStoreTargetsSync(params.cfg)
      .map((target) => target.storePath)
      .filter((storePath) => fs.existsSync(storePath)),
  );
  let cleared = 0;
  for (const storePath of storePaths) {
    cleared += await updateSessionStore(storePath, (store) => {
      let clearedInStore = 0;
      const now = Date.now();
      for (const [entryKey, entry] of Object.entries(store)) {
        if (
          !matchesCleanupSession(entryKey, entry, params.sessionKey) ||
          !hasPromotedSessionEntrySlot(entry, params.pluginId, params.sessionEntrySlotKeys)
        ) {
          continue;
        }
        clearPromotedSessionEntrySlots(entry, params.pluginId, params.sessionEntrySlotKeys, {
          includeStoredSlotKeys: false,
          pruneSlotOwnership: true,
        });
        entry.updatedAt = now;
        clearedInStore += 1;
      }
      return clearedInStore;
    });
  }
  return cleared;
}

function collectSessionEntrySlotKeys(
  registry: PluginRegistry | null | undefined,
  pluginId?: string,
): Set<string> {
  const slotKeys = new Set<string>();
  for (const registration of registry?.sessionExtensions ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, pluginId)) {
      continue;
    }
    const slotKey = registration.extension.sessionEntrySlotKey;
    if (slotKey === undefined) {
      continue;
    }
    const normalized = normalizeSessionEntrySlotKey(slotKey);
    if (normalized.ok) {
      slotKeys.add(normalized.key);
    }
  }
  return slotKeys;
}

export async function runPluginHostCleanup(params: {
  cfg?: OpenClawConfig;
  registry?: PluginRegistry | null;
  pluginId?: string;
  reason: PluginHostCleanupReason;
  sessionKey?: string;
  runId?: string;
  preserveSchedulerJobIds?: ReadonlySet<string>;
  shouldCleanup?: () => boolean;
  restartPromotedSessionEntrySlotKeys?: ReadonlySet<string>;
}): Promise<PluginHostCleanupResult> {
  const failures: PluginHostCleanupFailure[] = [];
  const shouldCleanup = params.shouldCleanup ?? (() => true);
  if (!shouldCleanup()) {
    return { cleanupCount: 0, failures };
  }
  const registry = params.registry;
  const sessionEntrySlotKeys = collectSessionEntrySlotKeys(
    registry ?? getActivePluginRegistry(),
    params.pluginId,
  );
  const restartPromotedSessionEntrySlotKeys =
    params.restartPromotedSessionEntrySlotKeys ?? sessionEntrySlotKeys;
  let persistentCleanupCount = 0;
  if (shouldCleanup()) {
    try {
      persistentCleanupCount =
        params.reason === "restart"
          ? await clearPromotedSessionEntrySlotStores({
              cfg: params.cfg ?? getRuntimeConfig(),
              pluginId: params.pluginId,
              sessionKey: params.sessionKey,
              sessionEntrySlotKeys: restartPromotedSessionEntrySlotKeys,
            })
          : await clearPluginOwnedSessionStores({
              cfg: params.cfg ?? getRuntimeConfig(),
              pluginId: params.pluginId,
              sessionKey: params.sessionKey,
              sessionEntrySlotKeys,
            });
    } catch (error) {
      failures.push({
        pluginId: params.pluginId ?? "plugin-host",
        hookId: "session-store",
        error,
      });
    }
  }
  let cleanupCount = persistentCleanupCount;
  if (registry) {
    for (const registration of registry.sessionExtensions ?? []) {
      if (!shouldCleanup()) {
        return { cleanupCount, failures };
      }
      if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
        continue;
      }
      const cleanup = registration.extension.cleanup;
      if (!cleanup) {
        continue;
      }
      const hookId = `session:${registration.extension.namespace}`;
      try {
        await withPluginHostCleanupTimeout(hookId, () =>
          cleanup({
            reason: params.reason,
            sessionKey: params.sessionKey,
          }),
        );
        cleanupCount += 1;
      } catch (error) {
        failures.push({
          pluginId: registration.pluginId,
          hookId,
          error,
        });
      }
    }
    for (const registration of registry.runtimeLifecycles ?? []) {
      if (!shouldCleanup()) {
        return { cleanupCount, failures };
      }
      if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
        continue;
      }
      const cleanup = registration.lifecycle.cleanup;
      if (!cleanup) {
        continue;
      }
      const hookId = `runtime:${registration.lifecycle.id}`;
      try {
        await withPluginHostCleanupTimeout(hookId, () =>
          cleanup({
            reason: params.reason,
            sessionKey: params.sessionKey,
            runId: params.runId,
          }),
        );
        cleanupCount += 1;
      } catch (error) {
        failures.push({
          pluginId: registration.pluginId,
          hookId,
          error,
        });
      }
    }
    const schedulerFailures = await cleanupPluginSessionSchedulerJobs({
      pluginId: params.pluginId,
      reason: params.reason,
      sessionKey: params.sessionKey,
      records: registry.sessionSchedulerJobs,
      preserveJobIds: params.preserveSchedulerJobIds,
      shouldCleanup,
    });
    for (const failure of schedulerFailures) {
      failures.push(failure);
    }
  }
  if (params.reason !== "restart" && shouldCleanup()) {
    const registrySchedulerJobKeys = new Set(
      (registry?.sessionSchedulerJobs ?? [])
        .filter((record) => !params.pluginId || record.pluginId === params.pluginId)
        .map((record) => ({
          pluginId: record.pluginId,
          jobId: typeof record.job.id === "string" ? record.job.id.trim() : "",
        }))
        .filter(({ jobId }) => jobId.length > 0)
        .map(({ pluginId, jobId }) => makePluginSessionSchedulerJobKey(pluginId, jobId)),
    );
    const runtimeSchedulerFailures = await cleanupPluginSessionSchedulerJobs({
      pluginId: params.pluginId,
      reason: params.reason,
      sessionKey: params.sessionKey,
      preserveJobIds: params.preserveSchedulerJobIds,
      excludeJobKeys: registrySchedulerJobKeys,
      shouldCleanup,
    });
    for (const failure of runtimeSchedulerFailures) {
      failures.push(failure);
    }
  }
  if (
    shouldCleanup() &&
    (params.pluginId || params.runId) &&
    (params.reason !== "restart" || params.runId)
  ) {
    clearPluginRunContext({ pluginId: params.pluginId, runId: params.runId });
  }
  return { cleanupCount, failures };
}

function collectHostHookPluginIds(registry: PluginRegistry): Set<string> {
  const ids = new Set<string>();
  for (const registration of registry.sessionExtensions ?? []) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.runtimeLifecycles ?? []) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.agentEventSubscriptions ?? []) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.sessionSchedulerJobs ?? []) {
    ids.add(registration.pluginId);
  }
  return ids;
}

function collectLoadedPluginIds(registry: PluginRegistry): Set<string> {
  return new Set(
    registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
  );
}

function collectSchedulerJobIds(
  registry: PluginRegistry | null | undefined,
  pluginId: string,
): Set<string> {
  return new Set(
    (registry?.sessionSchedulerJobs ?? [])
      .filter((registration) => registration.pluginId === pluginId)
      .map((registration) =>
        typeof registration.job.id === "string" ? registration.job.id.trim() : "",
      )
      .filter(Boolean),
  );
}

function collectRestartPromotedSessionEntrySlotKeys(
  previousRegistry: PluginRegistry,
  nextRegistry: PluginRegistry | null | undefined,
  pluginId: string,
): Set<string> {
  const staleSlotKeys = collectSessionEntrySlotKeys(previousRegistry, pluginId);
  const preservedSlotKeys = collectSessionEntrySlotKeys(nextRegistry, pluginId);
  for (const slotKey of preservedSlotKeys) {
    staleSlotKeys.delete(slotKey);
  }
  return staleSlotKeys;
}

export async function cleanupReplacedPluginHostRegistry(params: {
  cfg: OpenClawConfig;
  previousRegistry?: PluginRegistry | null;
  nextRegistry?: PluginRegistry | null;
  shouldCleanup?: () => boolean;
}): Promise<PluginHostCleanupResult> {
  const previousRegistry = params.previousRegistry;
  const shouldCleanup = params.shouldCleanup ?? (() => true);
  if (!previousRegistry || previousRegistry === params.nextRegistry || !shouldCleanup()) {
    return { cleanupCount: 0, failures: [] };
  }
  const nextPluginIds = params.nextRegistry
    ? collectLoadedPluginIds(params.nextRegistry)
    : new Set();
  const previousPluginIds = new Set([
    ...collectLoadedPluginIds(previousRegistry),
    ...collectHostHookPluginIds(previousRegistry),
  ]);
  const failures: PluginHostCleanupFailure[] = [];
  let cleanupCount = 0;
  for (const pluginId of previousPluginIds) {
    if (!shouldCleanup()) {
      break;
    }
    const restarted = nextPluginIds.has(pluginId);
    const result = await runPluginHostCleanup({
      cfg: params.cfg,
      registry: previousRegistry,
      pluginId,
      reason: restarted ? "restart" : "disable",
      preserveSchedulerJobIds: restarted
        ? collectSchedulerJobIds(params.nextRegistry, pluginId)
        : undefined,
      shouldCleanup,
      restartPromotedSessionEntrySlotKeys: restarted
        ? collectRestartPromotedSessionEntrySlotKeys(
            previousRegistry,
            params.nextRegistry,
            pluginId,
          )
        : undefined,
    });
    cleanupCount += result.cleanupCount;
    failures.push(...result.failures);
  }
  return { cleanupCount, failures };
}
