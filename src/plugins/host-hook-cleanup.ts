import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { getRuntimeConfig } from "../config/config.js";
import { cleanupPluginHostSessionStore } from "../config/sessions/session-accessor.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import {
  cleanupPluginSessionSchedulerJobs,
  clearPluginRunContext,
  makePluginSessionSchedulerJobKey,
} from "./host-hook-runtime.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import { getPluginInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { getPluginRecordRegistry } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";

/** Failure captured while running one plugin cleanup callback. */
type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

/** Aggregate cleanup result for plugin host state. */
type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
};

type ResolveCleanupSessionStoreTargets = () => readonly SessionStoreTarget[];

function shouldCleanPlugin(pluginId: string, filterPluginId?: string): boolean {
  return !filterPluginId || pluginId === filterPluginId;
}

async function clearPluginSessionStores(params: {
  cfg: OpenClawConfig;
  mode: "plugin-owned-state" | "promoted-slots";
  pluginId?: string;
  sessionKey?: string;
  sessionEntrySlotKeys?: ReadonlySet<string>;
  preserveLockedHarnessIds?: ReadonlySet<string>;
  storeTargets?: readonly SessionStoreTarget[];
  resolveStoreTargets?: ResolveCleanupSessionStoreTargets;
  shouldCleanup?: () => boolean;
}): Promise<number> {
  if (
    (!params.pluginId && !params.sessionKey) ||
    (params.mode === "promoted-slots" && params.sessionEntrySlotKeys?.size === 0)
  ) {
    return 0;
  }
  const storeTargets =
    params.storeTargets ??
    params.resolveStoreTargets?.() ??
    resolveAllAgentSessionStoreTargetsSync(params.cfg);
  let cleared = 0;
  for (const target of storeTargets) {
    if (params.shouldCleanup && !params.shouldCleanup()) {
      break;
    }
    cleared += await cleanupPluginHostSessionStore({
      agentId: target.agentId,
      storePath: target.storePath,
      mode: params.mode,
      pluginId: params.pluginId,
      sessionKey: params.sessionKey,
      sessionEntrySlotKeys: params.sessionEntrySlotKeys,
      preserveLockedHarnessIds: params.preserveLockedHarnessIds,
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
  sessionStoreTargets?: readonly SessionStoreTarget[];
  resolveSessionStoreTargets?: ResolveCleanupSessionStoreTargets;
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
  let cleanupCount = 0;
  if (!params.skipPersistentSessionState && shouldCleanup()) {
    try {
      cleanupCount = await clearPluginSessionStores({
        cfg: params.cfg ?? getRuntimeConfig(),
        mode: params.reason === "restart" ? "promoted-slots" : "plugin-owned-state",
        pluginId: params.pluginId,
        sessionKey: params.sessionKey,
        sessionEntrySlotKeys:
          params.reason === "restart" ? restartPromotedSessionEntrySlotKeys : sessionEntrySlotKeys,
        preserveLockedHarnessIds,
        storeTargets: params.sessionStoreTargets,
        resolveStoreTargets: params.resolveSessionStoreTargets,
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
  if (registry) {
    const context = { reason: params.reason, sessionKey: params.sessionKey };
    // Session extensions release state before runtime teardown; one failed hook must not skip its siblings.
    const cleanups = [
      ...registry.sessionExtensions.map(({ pluginId, extension }) => ({
        pluginId,
        hookId: `session:${extension.namespace}`,
        cleanup: extension.cleanup,
        context,
      })),
      ...registry.runtimeLifecycles.map(({ pluginId, lifecycle }) => ({
        pluginId,
        hookId: `runtime:${lifecycle.id}`,
        cleanup: lifecycle.cleanup,
        context: { ...context, runId: params.runId },
      })),
    ];
    for (const { pluginId, hookId, cleanup, context: cleanupContext } of cleanups) {
      if (!shouldCleanup()) {
        return { cleanupCount, failures };
      }
      if (!cleanup || !shouldCleanPlugin(pluginId, params.pluginId)) {
        continue;
      }
      try {
        await withPluginHostCleanupTimeout(hookId, () =>
          runPluginCleanup(cleanup, () => cleanup(cleanupContext)),
        );
        cleanupCount += 1;
      } catch (error) {
        failures.push({ pluginId, hookId, error });
      }
    }
    const schedulerFailures = await cleanupPluginSessionSchedulerJobs({
      pluginId: params.pluginId,
      reason: params.reason,
      sessionKey: params.sessionKey,
      records: registry.sessionSchedulerJobs,
      preserveJobIds: params.preserveSchedulerJobIds,
      cleanupOwnerRegistry: registry,
      preserveOwnerRegistry: params.preserveSchedulerOwnerRegistry,
      shouldCleanup,
    });
    failures.push(...schedulerFailures);
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
      cleanupOwnerRegistry: registry ?? undefined,
      shouldCleanup,
    });
    failures.push(...runtimeSchedulerFailures);
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

function collectHostHookPluginIds(registry: PluginRegistry): string[] {
  return [
    ...registry.sessionExtensions,
    ...registry.runtimeLifecycles,
    ...registry.agentEventSubscriptions,
    ...registry.sessionSchedulerJobs,
  ].map((registration) => registration.pluginId);
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

/** Prepares one retirement; each waiter keeps its caller's exact instance admission. */
export function createPluginHostRegistryRetirement(params: {
  cfg?: OpenClawConfig;
  previousRegistry?: PluginRegistry | null;
  nextRegistry?: PluginRegistry | null;
  shouldCleanup?: () => boolean;
  skipPersistentSessionState?: boolean;
}): () => Promise<PluginHostCleanupResult> {
  const previousRegistry = params.previousRegistry;
  const shouldCleanup = params.shouldCleanup ?? (() => true);
  if (!previousRegistry || previousRegistry === params.nextRegistry || !shouldCleanup()) {
    return async () => ({ cleanupCount: 0, failures: [] });
  }
  const nextPluginIds = params.nextRegistry
    ? collectLoadedPluginIds(params.nextRegistry)
    : new Set();
  const hostPluginIds = new Set([
    ...collectLoadedPluginIds(previousRegistry),
    ...collectHostHookPluginIds(previousRegistry),
  ]);
  const previousPluginIds = new Set([
    ...previousRegistry.plugins.map((record) => record.id),
    ...hostPluginIds,
  ]);
  let sessionStoreTargets: readonly SessionStoreTarget[] | undefined;
  const resolveSessionStoreTargets = () =>
    (sessionStoreTargets ??= resolveAllAgentSessionStoreTargetsSync(
      params.cfg ?? getRuntimeConfig(),
    ));
  const waits: Array<() => Promise<PluginHostCleanupResult>> = [];
  for (const pluginId of previousPluginIds) {
    const record = previousRegistry.plugins.find((entry) => entry.id === pluginId);
    // A delayed retirement cannot reclaim an instance already adopted by another registry.
    if (
      record &&
      (getPluginRecordRegistry(previousRegistry, record) !== previousRegistry ||
        params.nextRegistry?.plugins.includes(record))
    ) {
      continue;
    }
    const instance = record ? getPluginInstance(record) : undefined;
    const restarted = params.skipPersistentSessionState || nextPluginIds.has(pluginId);
    let result: PluginHostCleanupResult = { cleanupCount: 0, failures: [] };
    let hostFailure: AggregateError | undefined;
    const cleanup = hostPluginIds.has(pluginId)
      ? async () => {
          result = await runPluginHostCleanup({
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
            resolveSessionStoreTargets,
            skipPersistentSessionState: params.skipPersistentSessionState,
          });
          if (instance && result.failures.length) {
            hostFailure = new AggregateError(
              result.failures,
              `Plugin ${pluginId} host cleanup failed`,
            );
            throw hostFailure;
          }
        }
      : undefined;
    // Instance disposal retains its real completion even when this caller receives a self-ack.
    const completion = instance ? instance.dispose(cleanup) : Promise.resolve().then(cleanup);
    let preparationFailure: unknown;
    void completion.catch((error: unknown) => {
      preparationFailure = error;
    });
    waits.push(async () => {
      try {
        await (instance ? instance.dispose() : completion);
        if (preparationFailure) {
          // oxlint-disable-next-line typescript/only-throw-error -- Preserve the original disposal failure in the structured result.
          throw preparationFailure;
        }
        return result;
      } catch (error) {
        return {
          cleanupCount: result.cleanupCount,
          failures: [
            ...result.failures,
            ...(error instanceof AggregateError ? error.errors : [error])
              .filter((failure) => failure !== hostFailure)
              .map((failure) => ({ pluginId, hookId: "instance", error: failure })),
          ],
        };
      }
    });
  }
  return async () => {
    const results = await Promise.all(waits.map((wait) => wait()));
    return {
      cleanupCount: results.reduce((count, result) => count + result.cleanupCount, 0),
      failures: results.flatMap((result) => result.failures),
    };
  };
}
