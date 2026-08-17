// Context-engine registry owns engine registration, resolution, compatibility, and quarantine.
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.js";
import { createAbortError } from "../infra/abort-signal.js";
import type {
  ContextEngineFactory,
  ContextEngineFactoryContext,
  ContextEngineRegistration,
  ContextEngineRegistrationLifecycle,
} from "../plugins/registry-contribution-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "../plugins/runtime.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  listPersistedContextEngineQuarantines,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import type {
  BootstrapResult,
  ContextEngine,
  ContextEngineMaintenanceResult,
  IngestBatchResult,
  IngestResult,
} from "./types.js";

export type { ContextEngineFactory } from "../plugins/registry-contribution-types.js";

/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
  lifecycle?: ContextEngineRegistrationLifecycle;
};

type GuardedContextEngineMethodName = Exclude<keyof ContextEngine, "info" | "dispose">;
const GUARDED_CONTEXT_ENGINE_METHODS = new Set<PropertyKey>(
  "bootstrap maintain ingest ingestBatch afterTurn commitTurn assemble compact prepareSubagentSpawn onSubagentEnded".split(
    " ",
  ),
);
export const CONTEXT_ENGINE_HOST_PARAMS = new Set(
  "sessionKey prompt runtimeSettings sessionTarget runtimeContext".split(" "),
);
type ResolvedContextEngineMetadata = {
  owner: string;
  engineId: string;
};

const resolvedEngineMetadata = new WeakMap<ContextEngine, ResolvedContextEngineMetadata>();
function projectContextEngineHostParams(
  engine: ContextEngine,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const accepted = engine.info.acceptedHostParams;
  if (!accepted) {
    return params;
  }
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key]) => accepted.includes(key) || !CONTEXT_ENGINE_HOST_PARAMS.has(key),
    ),
  );
}

function wrapContextEngineHostParamProjection(
  engine: ContextEngine,
  metadata: ResolvedContextEngineMetadata,
): ContextEngine {
  const wrapped = new Proxy(
    Object.create(engine, { info: { get: () => engine.info } }) as ContextEngine,
    {
      get(_target, property) {
        if (property === "info") {
          return engine.info;
        }
        const method = Reflect.get(engine, property, engine);
        if (typeof method !== "function") {
          return method;
        }
        if (!GUARDED_CONTEXT_ENGINE_METHODS.has(property)) {
          return method.bind(engine);
        }
        return (params: Record<string, unknown>) =>
          method.call(engine, projectContextEngineHostParams(engine, params));
      },
    },
  );
  resolvedEngineMetadata.set(wrapped, metadata);
  return wrapped;
}

function wrapResolvedContextEngine(
  engine: ContextEngine,
  metadata: ResolvedContextEngineMetadata & {
    defaultEngineId?: string;
    factoryCtx?: ContextEngineFactoryContext;
  },
): ContextEngine {
  const fallback =
    metadata.defaultEngineId &&
    metadata.factoryCtx &&
    metadata.engineId !== metadata.defaultEngineId
      ? { defaultEngineId: metadata.defaultEngineId, factoryCtx: metadata.factoryCtx }
      : undefined;
  let fallbackEnginePromise: Promise<ContextEngine> | undefined;
  let resolvedFallbackEngine: ContextEngine | undefined;
  const getFallbackEngine = fallback
    ? () =>
        (fallbackEnginePromise ??= resolveDefaultContextEngine(
          fallback.defaultEngineId,
          fallback.factoryCtx,
        ).then((resolved) => {
          resolvedFallbackEngine = resolved;
          return resolved;
        }))
    : undefined;
  // A fresh target keeps Proxy invariants compatible with frozen engines and private getters.
  const wrapped = new Proxy(
    Object.create(engine, { info: { get: () => engine.info } }) as ContextEngine,
    {
      get(_target, property) {
        if (property === "info") {
          if (!fallback || !getContextEngineQuarantine(metadata.engineId)) {
            return engine.info;
          }
          return (
            resolvedFallbackEngine?.info ?? {
              id: fallback.defaultEngineId,
              name:
                fallback.defaultEngineId === "legacy"
                  ? "Legacy Context Engine"
                  : `${fallback.defaultEngineId} Context Engine`,
            }
          );
        }

        const method = Reflect.get(engine, property, engine);
        if (typeof method !== "function") {
          return method;
        }
        if (!GUARDED_CONTEXT_ENGINE_METHODS.has(property)) {
          return method.bind(engine);
        }
        if (!fallback || !getFallbackEngine) {
          return (params: Record<string, unknown>) =>
            method.call(engine, projectContextEngineHostParams(engine, params));
        }

        const methodName = property as GuardedContextEngineMethodName;
        return async (methodParams: Record<string, unknown>) => {
          const abortSignal = contextEngineAbortSignal(methodParams);
          if (abortSignal?.aborted) {
            const reason = abortSignal.reason;
            throw reason instanceof Error
              ? reason
              : createAbortError(
                  typeof reason === "string" && reason
                    ? reason
                    : "Context engine operation aborted.",
                );
          }
          const invokeFallback = () =>
            invokeFallbackContextEngineMethod({ getFallbackEngine, methodName, methodParams });
          if (getContextEngineQuarantine(metadata.engineId)) {
            // Runtime failures downgrade future guarded calls for this process.
            return await invokeFallback();
          }

          try {
            return await method.call(engine, projectContextEngineHostParams(engine, methodParams));
          } catch (error) {
            if (isContextEngineAbortRejection(error, abortSignal)) {
              // Abort is caller intent, not engine instability; never quarantine for it.
              throw error;
            }
            recordContextEngineQuarantine({
              engineId: metadata.engineId,
              owner: metadata.owner,
              operation: methodName,
              error,
              defaultEngineId: fallback.defaultEngineId,
            });
            if (methodName === "compact" || methodName === "prepareSubagentSpawn") {
              throw error;
            }
            return await invokeFallback().catch(() => {
              throw error;
            });
          }
        };
      },
    },
  );
  resolvedEngineMetadata.set(wrapped, metadata);
  return wrapped;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";

type ContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryState = {
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantine>;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    quarantinedEngines: new Map(),
  }),
);

const getContextEngines = () => requireActivePluginRegistry().contextEngines;

function requireContextEngineOwner(owner: string): string {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
  return normalizedOwner;
}

function recordContextEngineQuarantine(params: {
  engineId: string;
  owner?: string;
  operation: string;
  error: unknown;
  defaultEngineId: string;
}): ContextEngineRuntimeQuarantine {
  const existing = contextEngineRegistryState.quarantinedEngines.get(params.engineId);
  if (existing) {
    // First failure wins so logs and diagnostics point at the root cause, not follow-on fallback use.
    return existing;
  }

  const quarantine: ContextEngineRuntimeQuarantine = {
    engineId: params.engineId,
    operation: params.operation,
    reason: params.error instanceof Error ? params.error.message : String(params.error),
    failedAt: new Date(),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  contextEngineRegistryState.quarantinedEngines.set(params.engineId, quarantine);
  try {
    recordPersistedContextEngineQuarantine(quarantine);
  } catch {
    // Quarantine behavior must not depend on the best-effort health mirror.
  }
  const ownerSuffix = params.owner ? ` owner=${sanitizeForLog(params.owner)}` : "";
  console.error(
    `[context-engine] Context engine "${sanitizeForLog(params.engineId)}"${ownerSuffix} failed during ${sanitizeForLog(params.operation)}: ` +
      `${sanitizeForLog(quarantine.reason)}; quarantining it for this process and falling back to default engine "${params.defaultEngineId}".`,
  );
  return quarantine;
}

function getContextEngineQuarantine(engineId: string): ContextEngineRuntimeQuarantine | undefined {
  return contextEngineRegistryState.quarantinedEngines.get(engineId);
}

export function listContextEngineQuarantines(): ContextEngineRuntimeQuarantine[] {
  const quarantines = Array.from(
    contextEngineRegistryState.quarantinedEngines.values(),
    ({ failedAt, ...quarantine }) => ({ ...quarantine, failedAt: new Date(failedAt) }),
  );
  const seenEngineIds = new Set(quarantines.map((entry) => entry.engineId));
  return quarantines.concat(
    listPersistedContextEngineQuarantines().filter(({ engineId }) => !seenEngineIds.has(engineId)),
  );
}

function clearContextEngineRuntimeQuarantine(engineId: string): void {
  contextEngineRegistryState.quarantinedEngines.delete(engineId);
  clearPersistedContextEngineQuarantineForProcess(engineId, process.pid);
}

/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export function registerContextEngineForOwner(
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): ContextEngineRegistrationResult {
  const targetRegistry = requireActivePluginRegistry();
  const result = registerContextEngineInRegistry(targetRegistry, id, factory, owner, opts);
  if (
    result.ok &&
    (opts?.lifecycle ?? "runtime") === "runtime" &&
    getActivePluginRegistry() === targetRegistry
  ) {
    clearContextEngineRuntimeQuarantine(id);
  }
  return result;
}

/** Registers an engine in a registry value while that value is being assembled. */
export function registerContextEngineInRegistry(
  pluginRegistry: PluginRegistry,
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): ContextEngineRegistrationResult {
  const normalizedOwner = requireContextEngineOwner(owner);
  const lifecycle = opts?.lifecycle ?? "runtime";
  const registry = pluginRegistry.contextEngines;
  const existing = registry.get(id);
  if (
    id === defaultSlotIdForKey("contextEngine") &&
    normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER
  ) {
    // The default fallback id is core-owned; plugins can select other ids through slots.
    return { ok: false, existingOwner: CORE_CONTEXT_ENGINE_OWNER };
  }
  if (existing && existing.owner !== normalizedOwner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing?.lifecycle === "runtime" && lifecycle === "readOnlyDiscovery") {
    // Read-only discovery may re-run after live activation. It can collect metadata, but it must
    // not replace the runtime-safe factory with a closure that captured a read-only plugin mode.
    return { ok: true };
  }
  if (existing && opts?.allowSameOwnerRefresh !== true) {
    return { ok: false, existingOwner: existing.owner };
  }
  registry.set(id, { factory, owner: normalizedOwner, lifecycle });
  return { ok: true };
}

function canAdoptRuntimeContextEngineFromRoot(params: {
  pluginId: string | undefined;
  targetRegistry: PluginRegistry;
  runtimeRegistry: PluginRegistry;
}): boolean {
  if (!params.pluginId) {
    return false;
  }
  const targetPlugin = params.targetRegistry.plugins.find(
    (plugin) => plugin.id === params.pluginId,
  );
  const runtimePlugin = params.runtimeRegistry.plugins.find(
    (plugin) => plugin.id === params.pluginId,
  );
  // Same ids can come from workspace shadows. Only carry a factory across registry generations
  // when both registrations came from the exact same trusted plugin source.
  return Boolean(
    targetPlugin &&
    runtimePlugin &&
    targetPlugin.status === "loaded" &&
    runtimePlugin.status === "loaded" &&
    targetPlugin.source === runtimePlugin.source,
  );
}

/**
 * Scoped production handles stay in discovery mode so full-only plugins cannot
 * mutate process-global backends. Runtime context engines are adopted from the
 * composition-root registry instead of re-running `registrationMode: "full"`.
 */
export function adoptRuntimeContextEngineRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): PluginRegistry {
  let adopted: Map<string, ContextEngineRegistration> | undefined;
  const takeAdopted = () => {
    adopted ??= new Map(targetRegistry.contextEngines);
    return adopted;
  };

  for (const [id, runtime] of runtimeRegistry.contextEngines) {
    if (runtime.lifecycle !== "runtime") {
      continue;
    }
    const target = targetRegistry.contextEngines.get(id);
    if (target?.lifecycle === "runtime") {
      continue;
    }
    if (target && target.owner !== runtime.owner) {
      continue;
    }
    if (
      !canAdoptRuntimeContextEngineFromRoot({
        pluginId: pluginIdFromContextEngineOwner(runtime.owner),
        targetRegistry,
        runtimeRegistry,
      })
    ) {
      continue;
    }
    takeAdopted().set(id, runtime);
  }

  if (!adopted) {
    return targetRegistry;
  }
  // Copy-on-write so cached discovery snapshots are not mutated into runtime handles.
  return { ...targetRegistry, contextEngines: adopted };
}

/** Clear runtime quarantine only after a complete builder-local registry becomes active. */
export function activateContextEngineRegistrations(pluginRegistry: PluginRegistry): void {
  for (const [id, registration] of pluginRegistry.contextEngines) {
    if (registration.lifecycle === "runtime") {
      clearContextEngineRuntimeQuarantine(id);
    }
  }
}

/** Returns registration metadata so callers can distinguish discovery snapshots from runtime entries. */
export function getContextEngineRegistration(id: string): ContextEngineRegistration | undefined {
  return getContextEngines().get(id);
}

/**
 * List all registered engine ids.
 */
function listContextEngineIds(): string[] {
  return [...getContextEngines().keys()].toSorted();
}

export function clearContextEnginesForOwner(owner: string): void {
  const normalizedOwner = requireContextEngineOwner(owner);
  const registry = getContextEngines();
  for (const [id, entry] of registry.entries()) {
    if (entry.owner === normalizedOwner) {
      registry.delete(id);
      clearContextEngineRuntimeQuarantine(id);
    }
  }
}

/**
 * Return the trusted plugin id that registered a resolved context engine.
 */
export function resolveContextEngineOwnerPluginId(
  engine: ContextEngine | undefined | null,
): string | undefined {
  const metadata = engine ? resolvedEngineMetadata.get(engine) : undefined;
  // Downgraded work belongs to its core-owned fallback, never the disabled plugin.
  const owner =
    metadata && !getContextEngineQuarantine(metadata.engineId) ? metadata.owner : undefined;
  return owner ? pluginIdFromContextEngineOwner(owner) : undefined;
}

function pluginIdFromContextEngineOwner(owner: string): string | undefined {
  if (!owner.startsWith("plugin:")) {
    return undefined;
  }
  return owner.slice("plugin:".length).trim() || undefined;
}

function describeResolvedContextEngineContractError(
  engineId: string,
  engine: unknown,
): string | null {
  if (!engine || typeof engine !== "object") {
    return `Context engine "${engineId}" factory returned ${JSON.stringify(engine)} instead of a ContextEngine object.`;
  }

  const candidate = engine as Record<string, unknown>;
  const issues: string[] = [];
  const info = candidate.info;
  if (!info || typeof info !== "object") {
    issues.push("missing info");
  } else {
    // Engines own their internal info.id; it is metadata, not a handle into the
    // registry. The registered id (plugin slot id) and the engine's own id are
    // allowed to differ, so we only require that info.id is a non-empty string
    // for display/logging purposes and do not enforce equality with engineId.
    const infoRecord = info as Record<string, unknown>;
    for (const field of ["id", "name"]) {
      const value = infoRecord[field];
      if (typeof value !== "string" || !value.trim()) {
        issues.push(`missing info.${field}`);
      }
    }
  }

  for (const method of ["ingest", "assemble", "compact"]) {
    if (typeof candidate[method] !== "function") {
      issues.push(`missing ${method}()`);
    }
  }

  return issues.length === 0
    ? null
    : `Context engine "${engineId}" factory returned an invalid ContextEngine: ${issues.join(", ")}.`;
}

const CONTEXT_ENGINE_FALLBACK_RESULTS = {
  bootstrap: { bootstrapped: false, reason: "context engine downgraded to legacy" },
  maintain: {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
    reason: "context engine downgraded to legacy",
  },
  ingest: { ingested: false },
  ingestBatch: { ingestedCount: 0 },
} as const satisfies {
  bootstrap: BootstrapResult;
  maintain: ContextEngineMaintenanceResult;
  ingest: IngestResult;
  ingestBatch: IngestBatchResult;
};

function contextEngineAbortSignal(methodParams: unknown): AbortSignal | undefined {
  const signal = (methodParams as { abortSignal?: unknown } | null | undefined)?.abortSignal;
  return signal && typeof signal === "object" && "aborted" in signal
    ? (signal as AbortSignal)
    : undefined;
}

function isContextEngineAbortRejection(error: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || /abort|cancelled|canceled/iu.test(error.message);
  }
  return typeof error === "string" && /abort|cancelled|canceled/iu.test(error);
}

async function invokeFallbackContextEngineMethod(params: {
  getFallbackEngine: () => Promise<ContextEngine>;
  methodName: GuardedContextEngineMethodName;
  methodParams: unknown;
}): Promise<unknown> {
  const fallbackEngine = await params.getFallbackEngine();
  const fallbackMethod = fallbackEngine[params.methodName] as
    | ((methodParams: unknown) => unknown)
    | undefined;
  if (typeof fallbackMethod === "function") {
    return await fallbackMethod.call(fallbackEngine, params.methodParams);
  }
  if (params.methodName === "assemble" || params.methodName === "compact") {
    throw new Error(`No legacy fallback result for ${params.methodName}`);
  }
  const fallbackResult =
    CONTEXT_ENGINE_FALLBACK_RESULTS[
      params.methodName as keyof typeof CONTEXT_ENGINE_FALLBACK_RESULTS
    ];
  return fallbackResult ? { ...fallbackResult } : undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolveContextEngine}.
 */
export type ResolveContextEngineOptions = {
  agentDir?: string;
  workspaceDir?: string;
};

export type ResolvedContextEngineRef = Readonly<{
  engine: ContextEngine;
  registeredId: string;
  ownerPluginId?: string;
}>;

export type LogicalTurnContextEngineResolution = {
  configured: ResolvedContextEngineRef;
  configuredId: string;
  configuredFailure?: string;
  fallback: ResolvedContextEngineRef;
};

function resolvedContextEngineRef(params: {
  engine: ContextEngine;
  registeredId: string;
  owner: string;
}): ResolvedContextEngineRef {
  const pluginId = pluginIdFromContextEngineOwner(params.owner);
  return Object.freeze({
    engine: params.engine,
    registeredId: params.registeredId,
    ...(pluginId ? { ownerPluginId: pluginId } : {}),
  });
}

async function resolveRawContextEngineRef(
  engineId: string,
  factoryCtx: ContextEngineFactoryContext,
): Promise<ResolvedContextEngineRef> {
  const entry = getContextEngines().get(engineId);
  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }
  const engine = await entry.factory(factoryCtx);
  const contractError = describeResolvedContextEngineContractError(engineId, engine);
  if (contractError) {
    await Promise.resolve((engine as ContextEngine | undefined)?.dispose?.()).catch(
      () => undefined,
    );
    throw new Error(contractError);
  }
  const projectedEngine = wrapContextEngineHostParamProjection(engine, {
    engineId,
    owner: entry.owner,
  });
  return resolvedContextEngineRef({
    engine: projectedEngine,
    registeredId: engineId,
    owner: entry.owner,
  });
}

/**
 * Resolve fresh engines for one logical turn without consulting or mutating
 * process quarantine. A failed configured engine is retried by the next turn.
 */
export async function resolveLogicalTurnContextEngines(
  config?: OpenClawConfig,
  options?: ResolveContextEngineOptions,
): Promise<LogicalTurnContextEngineResolution> {
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  const slotValue = config?.plugins?.slots?.contextEngine;
  const configuredEngineId =
    typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultEngineId;
  const factoryCtx: ContextEngineFactoryContext = {
    config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
  };
  const fallback = await resolveRawContextEngineRef(defaultEngineId, factoryCtx);
  if (configuredEngineId === defaultEngineId) {
    return { configured: fallback, configuredId: configuredEngineId, fallback };
  }
  const entry = getContextEngines().get(configuredEngineId);
  if (!entry) {
    return {
      configured: fallback,
      configuredId: configuredEngineId,
      configuredFailure: `context engine "${configuredEngineId}" is not registered`,
      fallback,
    };
  }
  if (entry.lifecycle === "readOnlyDiscovery") {
    return {
      configured: fallback,
      configuredId: configuredEngineId,
      configuredFailure: `context engine "${configuredEngineId}" is available for discovery only`,
      fallback,
    };
  }
  try {
    const configured = await resolveRawContextEngineRef(configuredEngineId, factoryCtx);
    return {
      configured,
      configuredId: configuredEngineId,
      fallback,
    };
  } catch (error) {
    return {
      configured: fallback,
      configuredId: configuredEngineId,
      configuredFailure: error instanceof Error ? error.message : String(error),
      fallback,
    };
  }
}

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * When `config` is provided it is forwarded to the factory as part of a
 * {@link ContextEngineFactoryContext}. Additional runtime paths can be
 * supplied via `options`. Existing no-arg factories continue to work
 * because JavaScript permits extra arguments at call sites.
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Throws only when the default engine itself cannot be resolved.
 */
export async function resolveContextEngine(
  config?: OpenClawConfig,
  options?: ResolveContextEngineOptions,
): Promise<ContextEngine> {
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultEngineId;
  const isDefaultEngine = engineId === defaultEngineId;

  const factoryCtx: ContextEngineFactoryContext = {
    config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
  };

  const quarantine = !isDefaultEngine ? getContextEngineQuarantine(engineId) : undefined;
  if (quarantine) {
    // Previously failed custom engines stay downgraded until explicit quarantine clear/restart.
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  const entry = getContextEngines().get(engineId);
  if (!entry) {
    if (isDefaultEngine) {
      throw new Error(
        `Context engine "${engineId}" is not registered. ` +
          `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
      );
    }
    recordContextEngineQuarantine({
      engineId,
      operation: "resolve",
      error: "not registered",
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  if (!isDefaultEngine && entry.lifecycle === "readOnlyDiscovery") {
    console.warn(
      `[context-engine] Context engine "${engineId}" owner=${entry.owner} is registered for read-only discovery only; falling back to default engine "${defaultEngineId}" without quarantine until runtime activation registers it.`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  let engine: ContextEngine;
  let operation: "factory" | "contract-validation" = "factory";
  try {
    engine = await entry.factory(factoryCtx);
    operation = "contract-validation";
    const contractError = describeResolvedContextEngineContractError(engineId, engine);
    if (contractError) {
      throw new Error(contractError);
    }
  } catch (error) {
    if (isDefaultEngine) {
      throw error;
    }
    recordContextEngineQuarantine({
      engineId,
      owner: entry.owner,
      operation,
      error,
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  return wrapResolvedContextEngine(engine, {
    owner: entry.owner,
    engineId,
    defaultEngineId,
    factoryCtx,
  });
}

/**
 * Resolve the default context engine as a last-resort fallback.
 *
 * This helper is intentionally strict: if the default engine itself fails,
 * there is no further fallback and the error must propagate.
 */
async function resolveDefaultContextEngine(
  defaultEngineId: string,
  factoryCtx: ContextEngineFactoryContext,
): Promise<ContextEngine> {
  const defaultEntry = getContextEngines().get(defaultEngineId);
  if (!defaultEntry) {
    throw new Error(
      `[context-engine] fallback failed: default engine "${defaultEngineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }
  const engine = await defaultEntry.factory(factoryCtx);
  const contractError = describeResolvedContextEngineContractError(defaultEngineId, engine);
  if (contractError) {
    throw new Error(`[context-engine] ${contractError}`);
  }
  return wrapResolvedContextEngine(engine, {
    owner: defaultEntry.owner,
    engineId: defaultEngineId,
  });
}
