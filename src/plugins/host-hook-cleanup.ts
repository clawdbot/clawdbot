import fs from "node:fs";
import { updateSessionStore } from "../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { cleanupPluginSessionSchedulerJobs, clearPluginRunContext } from "./host-hook-runtime.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";

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

export function clearPluginOwnedSessionState(entry: SessionEntry, pluginId?: string): void {
  if (!pluginId) {
    delete entry.pluginExtensions;
    delete entry.pluginNextTurnInjections;
    return;
  }
  if (entry.pluginExtensions) {
    delete entry.pluginExtensions[pluginId];
    if (Object.keys(entry.pluginExtensions).length === 0) {
      delete entry.pluginExtensions;
    }
  }
  if (entry.pluginNextTurnInjections) {
    delete entry.pluginNextTurnInjections[pluginId];
    if (Object.keys(entry.pluginNextTurnInjections).length === 0) {
      delete entry.pluginNextTurnInjections;
    }
  }
}

function hasPluginOwnedSessionState(entry: SessionEntry, pluginId?: string): boolean {
  if (!pluginId) {
    return Boolean(entry.pluginExtensions || entry.pluginNextTurnInjections);
  }
  return Boolean(entry.pluginExtensions?.[pluginId] || entry.pluginNextTurnInjections?.[pluginId]);
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
          !hasPluginOwnedSessionState(entry, params.pluginId)
        ) {
          continue;
        }
        clearPluginOwnedSessionState(entry, params.pluginId);
        entry.updatedAt = now;
        clearedInStore += 1;
      }
      return clearedInStore;
    });
  }
  return cleared;
}

export async function runPluginHostCleanup(params: {
  cfg: OpenClawConfig;
  registry?: PluginRegistry | null;
  pluginId?: string;
  reason: PluginHostCleanupReason;
  sessionKey?: string;
  runId?: string;
  preserveSchedulerJobIds?: ReadonlySet<string>;
}): Promise<PluginHostCleanupResult> {
  const persistentCleanupCount =
    params.reason === "restart"
      ? 0
      : await clearPluginOwnedSessionStores({
          cfg: params.cfg,
          pluginId: params.pluginId,
          sessionKey: params.sessionKey,
        });
  const registry = params.registry;
  if (!registry) {
    return { cleanupCount: persistentCleanupCount, failures: [] };
  }
  const failures: PluginHostCleanupFailure[] = [];
  let cleanupCount = persistentCleanupCount;
  for (const registration of registry.sessionExtensions ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
      continue;
    }
    const cleanup = registration.extension.cleanup;
    if (!cleanup) {
      continue;
    }
    try {
      await cleanup({
        reason: params.reason,
        sessionKey: params.sessionKey,
      });
      cleanupCount += 1;
    } catch (error) {
      failures.push({
        pluginId: registration.pluginId,
        hookId: `session:${registration.extension.namespace}`,
        error,
      });
    }
  }
  for (const registration of registry.runtimeLifecycles ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
      continue;
    }
    const cleanup = registration.lifecycle.cleanup;
    if (!cleanup) {
      continue;
    }
    try {
      await cleanup({
        reason: params.reason,
        sessionKey: params.sessionKey,
        runId: params.runId,
      });
      cleanupCount += 1;
    } catch (error) {
      failures.push({
        pluginId: registration.pluginId,
        hookId: `runtime:${registration.lifecycle.id}`,
        error,
      });
    }
  }
  const schedulerFailures = await cleanupPluginSessionSchedulerJobs({
    pluginId: params.pluginId,
    reason: params.reason,
    sessionKey: params.sessionKey,
    records: registry?.sessionSchedulerJobs,
    preserveJobIds: params.preserveSchedulerJobIds,
  });
  for (const failure of schedulerFailures) {
    failures.push(failure);
  }
  if (params.pluginId || params.runId) {
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

export async function cleanupReplacedPluginHostRegistry(params: {
  cfg: OpenClawConfig;
  previousRegistry?: PluginRegistry | null;
  nextRegistry?: PluginRegistry | null;
}): Promise<PluginHostCleanupResult> {
  const previousRegistry = params.previousRegistry;
  if (!previousRegistry || previousRegistry === params.nextRegistry) {
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
    const restarted = nextPluginIds.has(pluginId);
    const result = await runPluginHostCleanup({
      cfg: params.cfg,
      registry: previousRegistry,
      pluginId,
      reason: restarted ? "restart" : "disable",
      preserveSchedulerJobIds: restarted
        ? collectSchedulerJobIds(params.nextRegistry, pluginId)
        : undefined,
    });
    cleanupCount += result.cleanupCount;
    failures.push(...result.failures);
  }
  return { cleanupCount, failures };
}
