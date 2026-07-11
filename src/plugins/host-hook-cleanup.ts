/** Runs plugin cleanup callbacks and clears host-side plugin session/runtime state. */
import fs from "node:fs";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  cleanupPluginHostSessionStore,
  clearPluginOwnedSessionState,
} from "../config/sessions/session-accessor.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

export { clearPluginOwnedSessionState };

/** Failure captured while running plugin cleanup hooks. */
/** Failure captured while running one plugin cleanup callback. */
export type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

/** Aggregate cleanup result for plugin host state. */
export type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
};

type ResolveCleanupSessionStorePaths = () => readonly string[];

function shouldCleanPlugin(pluginId: string, filterPluginId?: string): boolean {
  return !filterPluginId || pluginId === filterPluginId;
}

function resolveExistingSessionStorePaths(cfg: OpenClawConfig): string[] {
  return [
    ...new Set(
      resolveAllAgentSessionStoreTargetsSync(cfg)
        .map((target) => target.storePath)
        .filter((storePath) => fs.existsSync(storePath)),
    ),
  ];
}

function createMemoizedCleanupSessionStorePathResolver(
  cfg: OpenClawConfig,
): ResolveCleanupSessionStorePaths {
  let paths: readonly string[] | undefined;
  return () => {
    paths ??= resolveExistingSessionStorePaths(cfg);
    return paths;
  };
}

function resolveCleanupSessionStorePaths(params: {
  cfg: OpenClawConfig;
  storePaths?: readonly string[];
  resolveStorePaths?: ResolveCleanupSessionStorePaths;
}): readonly string[] {
  return (
    params.storePaths ??
    params.resolveStorePaths?.() ??
    resolveExistingSessionStorePaths(params.cfg)
  );
}

async function clearPluginOwnedSessionStores(params: {
  cfg: OpenClawConfig;
  pluginId?: string;
  sessionKey?: string;
  sessionEntrySlotKeys?: ReadonlySet<string>;
  storePaths?: readonly string[];
  resolveStorePaths?: ResolveCleanupSessionStorePaths;
  preserveLockedHarnessIds?: ReadonlySet<string>;
  shouldCleanup?: () => boolean;
}): Promise<number> {
  if (!params.pluginId && !params.sessionKey) {
    return 0;
  }
  const storePaths = resolveCleanupSessionStorePaths(params);
  let cleared = 0;
  for (const storePath of storePaths) {
    if (params.shouldCleanup && !params.shouldCleanup()) {
      break;
    }
    cleared += await cleanupPluginHostSessionStore({
      storePath,
      mode: "plugin-owned-state",
      pluginId: params.pluginId,
      sessionKey: params.sessionKey,
      sessionEntrySlotKeys: params.sessionEntrySlotKeys,
      preserveLockedHarnessIds: params.preserveLockedHarnessIds,
      shouldCleanup: params.shouldCleanup,
    });
  }
  return cleared;
}

async function clearPromotedSessionEntrySlotStores(params: {
  cfg: OpenClawConfig;
  pluginId?: string;
  sessionKey?: string;
  sessionEntrySlotKeys: ReadonlySet<string>;
  storePaths?: readonly string[];
  resolveStorePaths?: ResolveCleanupSessionStorePaths;
  shouldCleanup?: () => boolean;
}): Promise<number> {
  if ((!params.pluginId && !params.sessionKey) || params.sessionEntrySlotKeys.size === 0) {
    return 0;
  }
  const storePaths = resolveCleanupSessionStorePaths(params);
  let cleared = 0;
  for (const storePath of storePaths) {
    if (params.shouldCleanup && !params.shouldCleanup()) {
      break;
    }
    cleared += await cleanupPluginHostSessionStore({
      storePath,
      mode: "promoted-slots",
      pluginId: params.pluginId,
      sessionKey: params.sessionKey,
      sessionEntrySlotKeys: params.sessionEntrySlotKeys,
      shouldCleanup: params.shouldCleanup,
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

function collectAgentHarnessIds(
  registry: PluginRegistry | null | undefined,
  pluginId?: string,
): Set<string> {
  const harnessIds = new Set<string>();
  for (const registration of registry?.agentHarnesses ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, pluginId)) {
      continue;
    }
    const harnessId = normalizeOptionalAgentRuntimeId(registration.harness.id);
    if (harnessId) {
      harnessIds.add(harnessId);
    }
  }
  return harnessIds;
}

/** Runs persistent and in-memory cleanup for a plugin, session, or host lifecycle event. */
/** Runs cleanup callbacks for one plugin and returns failures instead of throwing. */
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
  preserveSchedulerOwnerRegistry?: PluginRegistry | null;
  sessionStorePaths?: readonly string[];
  resolveSessionStorePaths?: ResolveCleanupSessionStorePaths;
  skipPersistentSessionState?: boolean;
}): Promise<PluginHostCleanupResult> {
  const failures: PluginHostCleanupFailure[] = [];
  const shouldCleanup = params.shouldCleanup ?? (() => true);
  if (!shouldCleanup()) {
    return { cleanupCount: 0, failures };
  }
  const registry = params.registry;
  const cleanupRegistry = registry ?? getActivePluginRegistry();
  const sessionEntrySlotKeys = collectSessionEntrySlotKeys(cleanupRegistry, params.pluginId);
  const preserveLockedHarnessIds =
    params.reason === "disable"
      ? collectAgentHarnessIds(cleanupRegistry, params.pluginId)
      : undefined;
  const restartPromotedSessionEntrySlotKeys =
    params.restartPromotedSessionEntrySlotKeys ?? sessionEntrySlotKeys;
  let persistentCleanupCount = 0;
  if (!params.skipPersistentSessionState && shouldCleanup()) {
    try {
      persistentCleanupCount =
        params.reason === "restart"
          ? await clearPromotedSessionEntrySlotStores({
              cfg: params.cfg ?? getRuntimeConfig(),
              pluginId: params.pluginId,
              sessionKey: params.sessionKey,
              sessionEntrySlotKeys: restartPromotedSessionEntrySlotKeys,
              storePaths: params.sessionStorePaths,
              resolveStorePaths: params.resolveSessionStorePaths,
              shouldCleanup,
            })
          : await clearPluginOwnedSessionStores({
              cfg: params.cfg ?? getRuntimeConfig(),
              pluginId: params.pluginId,
              sessionKey: params.sessionKey,
              sessionEntrySlotKeys,
              storePaths: params.sessionStorePaths,
              resolveStorePaths: params.resolveSessionStorePaths,
              preserveLockedHarnessIds,
              shouldCleanup,
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
    for (const registration of registry.sessionExtensions) {
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
    for (const registration of registry.runtimeLifecycles) {
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
      preserveOwnerRegistry: params.preserveSchedulerOwnerRegistry,
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
  for (const registration of registry.sessionExtensions) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.runtimeLifecycles) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.agentEventSubscriptions) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.sessionSchedulerJobs) {
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

/** Cleans up plugin host state when a registry snapshot is replaced. */
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
  const resolveSessionStorePaths = createMemoizedCleanupSessionStorePathResolver(params.cfg);
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
      preserveSchedulerOwnerRegistry: restarted ? params.nextRegistry : undefined,
      resolveSessionStorePaths,
    });
    cleanupCount += result.cleanupCount;
    failures.push(...result.failures);
  }
  return { cleanupCount, failures };
}
