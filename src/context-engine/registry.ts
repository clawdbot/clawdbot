import type { OpenClawConfig } from "../config/types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineMaintenanceResult,
  IngestBatchResult,
  IngestResult,
  SubagentSpawnPreparation,
  ContextEngineInfo,
} from "./types.js";

/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 *
 * The factory receives a {@link ContextEngineFactoryContext} with runtime
 * environment context (config, paths). Existing no-arg factories remain
 * backward compatible because TypeScript permits assigning functions with
 * fewer parameters to wider signatures.
 */
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
};

const LEGACY_SESSION_KEY_COMPAT = Symbol.for("openclaw.contextEngine.sessionKeyCompat");
type ResolvedContextEngineMetadata = {
  owner: string;
};

type RuntimeQuarantineProxyState = {
  engineId: string;
  getResolvedFallbackEngine: () => ContextEngine | undefined;
};

const RESOLVED_CONTEXT_ENGINE_METADATA = new WeakMap<
  ContextEngine,
  ResolvedContextEngineMetadata
>();
const RUNTIME_QUARANTINE_PROXY_STATE = new WeakMap<ContextEngine, RuntimeQuarantineProxyState>();
const SESSION_KEY_COMPAT_METHODS = [
  "bootstrap",
  "maintain",
  "ingest",
  "ingestBatch",
  "afterTurn",
  "assemble",
  "compact",
] as const;
const LEGACY_COMPAT_PARAMS = ["sessionKey", "prompt"] as const;
const LEGACY_COMPAT_METHOD_KEYS = {
  bootstrap: ["sessionKey"],
  maintain: ["sessionKey"],
  ingest: ["sessionKey"],
  ingestBatch: ["sessionKey"],
  afterTurn: ["sessionKey"],
  assemble: ["sessionKey", "prompt"],
  compact: ["sessionKey"],
} as const;

type SessionKeyCompatMethodName = (typeof SESSION_KEY_COMPAT_METHODS)[number];
type SessionKeyCompatParams = {
  sessionKey?: string;
  prompt?: string;
};
type LegacyCompatKey = (typeof LEGACY_COMPAT_PARAMS)[number];
type LegacyCompatParamMap = Partial<Record<LegacyCompatKey, unknown>>;

function isSessionKeyCompatMethodName(value: PropertyKey): value is SessionKeyCompatMethodName {
  return (
    typeof value === "string" && (SESSION_KEY_COMPAT_METHODS as readonly string[]).includes(value)
  );
}

function hasOwnLegacyCompatKey<K extends LegacyCompatKey>(
  params: unknown,
  key: K,
): params is SessionKeyCompatParams & Required<Pick<LegacyCompatParamMap, K>> {
  return (
    params !== null &&
    typeof params === "object" &&
    Object.prototype.hasOwnProperty.call(params, key)
  );
}

function withoutLegacyCompatKeys<T extends SessionKeyCompatParams>(
  params: T,
  keys: Iterable<LegacyCompatKey>,
): T {
  const legacyParams = { ...params };
  for (const key of keys) {
    delete legacyParams[key];
  }
  return legacyParams;
}

function issueRejectsLegacyCompatKeyStrictly(issue: unknown, key: LegacyCompatKey): boolean {
  if (!issue || typeof issue !== "object") {
    return false;
  }

  const issueRecord = issue as {
    code?: unknown;
    keys?: unknown;
    message?: unknown;
  };
  if (
    issueRecord.code === "unrecognized_keys" &&
    Array.isArray(issueRecord.keys) &&
    issueRecord.keys.some((issueKey) => issueKey === key)
  ) {
    return true;
  }

  return isLegacyCompatErrorForKey(issueRecord.message, key);
}

function* iterateErrorChain(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    yield current;
    seen.add(current);
    if (typeof current !== "object") {
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
}

const LEGACY_UNKNOWN_FIELD_PATTERNS: Record<LegacyCompatKey, readonly RegExp[]> = {
  sessionKey: [
    /\bunrecognized key(?:\(s\)|s)? in object:.*['"`]sessionKey['"`]/i,
    /\badditional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
    /\bmust not have additional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
    /\b(?:unexpected|extraneous)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
    /\b(?:unknown|invalid)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
    /['"`]sessionKey['"`].*\b(?:was|is)\s+not allowed\b/i,
    /"code"\s*:\s*"unrecognized_keys"[^]*"sessionKey"/i,
  ],
  prompt: [
    /\bunrecognized key(?:\(s\)|s)? in object:.*['"`]prompt['"`]/i,
    /\badditional propert(?:y|ies)\b.*['"`]prompt['"`]/i,
    /\bmust not have additional propert(?:y|ies)\b.*['"`]prompt['"`]/i,
    /\b(?:unexpected|extraneous)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]prompt['"`]/i,
    /\b(?:unknown|invalid)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]prompt['"`]/i,
    /['"`]prompt['"`].*\b(?:was|is)\s+not allowed\b/i,
    /"code"\s*:\s*"unrecognized_keys"[^]*"prompt"/i,
  ],
} as const;

function isLegacyCompatUnknownFieldValidationMessage(
  message: string,
  key: LegacyCompatKey,
): boolean {
  return LEGACY_UNKNOWN_FIELD_PATTERNS[key].some((pattern) => pattern.test(message));
}

function isLegacyCompatErrorForKey(error: unknown, key: LegacyCompatKey): boolean {
  for (const candidate of iterateErrorChain(error)) {
    if (Array.isArray(candidate)) {
      if (candidate.some((entry) => issueRejectsLegacyCompatKeyStrictly(entry, key))) {
        return true;
      }
      continue;
    }

    if (typeof candidate === "string") {
      if (isLegacyCompatUnknownFieldValidationMessage(candidate, key)) {
        return true;
      }
      continue;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const issueContainer = candidate as {
      message?: unknown;
      issues?: unknown;
      errors?: unknown;
    };

    if (
      Array.isArray(issueContainer.issues) &&
      issueContainer.issues.some((issue) => issueRejectsLegacyCompatKeyStrictly(issue, key))
    ) {
      return true;
    }

    if (
      Array.isArray(issueContainer.errors) &&
      issueContainer.errors.some((issue) => issueRejectsLegacyCompatKeyStrictly(issue, key))
    ) {
      return true;
    }

    if (
      typeof issueContainer.message === "string" &&
      isLegacyCompatUnknownFieldValidationMessage(issueContainer.message, key)
    ) {
      return true;
    }
  }

  return false;
}

function detectRejectedLegacyCompatKeys(
  error: unknown,
  allowedKeys: readonly LegacyCompatKey[],
): Set<LegacyCompatKey> {
  const rejectedKeys = new Set<LegacyCompatKey>();
  for (const key of allowedKeys) {
    if (isLegacyCompatErrorForKey(error, key)) {
      rejectedKeys.add(key);
    }
  }
  return rejectedKeys;
}

async function invokeWithLegacyCompat<TResult, TParams extends SessionKeyCompatParams>(
  method: (params: TParams) => Promise<TResult> | TResult,
  params: TParams,
  allowedKeys: readonly LegacyCompatKey[],
  opts?: {
    onLegacyModeDetected?: () => void;
    onLegacyKeysDetected?: (keys: Set<LegacyCompatKey>) => void;
    rejectedKeys?: ReadonlySet<LegacyCompatKey>;
  },
): Promise<TResult> {
  const activeRejectedKeys = new Set(opts?.rejectedKeys ?? []);
  const availableKeys = allowedKeys.filter((key) => hasOwnLegacyCompatKey(params, key));
  if (availableKeys.length === 0) {
    return await method(params);
  }

  let currentParams =
    activeRejectedKeys.size > 0 ? withoutLegacyCompatKeys(params, activeRejectedKeys) : params;

  try {
    return await method(currentParams);
  } catch (error) {
    let currentError = error;
    while (true) {
      const rejectedKeys = detectRejectedLegacyCompatKeys(currentError, availableKeys);
      let learnedNewKey = false;
      for (const key of rejectedKeys) {
        if (!activeRejectedKeys.has(key)) {
          activeRejectedKeys.add(key);
          learnedNewKey = true;
        }
      }

      if (!learnedNewKey) {
        throw currentError;
      }

      opts?.onLegacyModeDetected?.();
      opts?.onLegacyKeysDetected?.(rejectedKeys);
      currentParams = withoutLegacyCompatKeys(params, activeRejectedKeys);

      try {
        return await method(currentParams);
      } catch (retryError) {
        currentError = retryError;
      }
    }
  }
}

function wrapContextEngineWithSessionKeyCompat(engine: ContextEngine): ContextEngine {
  const marked = engine as ContextEngine & {
    [LEGACY_SESSION_KEY_COMPAT]?: boolean;
  };
  if (marked[LEGACY_SESSION_KEY_COMPAT]) {
    return engine;
  }

  let isLegacy = false;
  const rejectedKeys = new Set<LegacyCompatKey>();
  const proxy: ContextEngine = new Proxy(engine, {
    get(target, property, receiver) {
      if (property === LEGACY_SESSION_KEY_COMPAT) {
        return true;
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (!isSessionKeyCompatMethodName(property)) {
        return value.bind(target);
      }

      return (params: SessionKeyCompatParams) => {
        const method = value.bind(target) as (params: SessionKeyCompatParams) => unknown;
        const allowedKeys = LEGACY_COMPAT_METHOD_KEYS[property];
        if (
          isLegacy &&
          allowedKeys.some((key) => rejectedKeys.has(key) && hasOwnLegacyCompatKey(params, key))
        ) {
          return method(withoutLegacyCompatKeys(params, rejectedKeys));
        }
        return invokeWithLegacyCompat(method, params, allowedKeys, {
          onLegacyModeDetected: () => {
            isLegacy = true;
          },
          onLegacyKeysDetected: (keys) => {
            for (const key of keys) {
              rejectedKeys.add(key);
            }
          },
          rejectedKeys,
        });
      };
    },
  });
  return proxy;
}

function wrapResolvedContextEngine(
  engine: ContextEngine,
  metadata: {
    owner: string;
    engineId: string;
    defaultEngineId?: string;
    factoryCtx?: ContextEngineFactoryContext;
  },
): ContextEngine {
  const compatWrapped = wrapContextEngineWithSessionKeyCompat(engine);
  const wrapped =
    metadata.defaultEngineId &&
    metadata.factoryCtx &&
    metadata.engineId !== metadata.defaultEngineId
      ? wrapContextEngineWithRuntimeQuarantine({
          engine: compatWrapped,
          engineId: metadata.engineId,
          owner: metadata.owner,
          defaultEngineId: metadata.defaultEngineId,
          factoryCtx: metadata.factoryCtx,
        })
      : compatWrapped;
  RESOLVED_CONTEXT_ENGINE_METADATA.set(wrapped, metadata);
  return wrapped;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";
const PUBLIC_CONTEXT_ENGINE_OWNER = "public-sdk";

export type ContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryState = {
  engines: Map<
    string,
    {
      factory: ContextEngineFactory;
      owner: string;
    }
  >;
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantine>;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    engines: new Map(),
    quarantinedEngines: new Map(),
  }),
);

function getContextEngineRegistryState(): ContextEngineRegistryState {
  return contextEngineRegistryState;
}

function requireContextEngineOwner(owner: string): string {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
  return normalizedOwner;
}

function formatContextEngineError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordContextEngineQuarantine(params: {
  engineId: string;
  owner?: string;
  operation: string;
  error: unknown;
  defaultEngineId: string;
}): ContextEngineRuntimeQuarantine {
  const registryState = getContextEngineRegistryState();
  const existing = registryState.quarantinedEngines.get(params.engineId);
  if (existing) {
    return existing;
  }

  const quarantine: ContextEngineRuntimeQuarantine = {
    engineId: params.engineId,
    operation: params.operation,
    reason: formatContextEngineError(params.error),
    failedAt: new Date(),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  registryState.quarantinedEngines.set(params.engineId, quarantine);
  const ownerSuffix = params.owner ? ` owner=${sanitizeForLog(params.owner)}` : "";
  console.error(
    `[context-engine] Context engine "${sanitizeForLog(params.engineId)}"${ownerSuffix} failed during ${sanitizeForLog(params.operation)}: ` +
      `${sanitizeForLog(quarantine.reason)}; quarantining it for this process and falling back to default engine "${params.defaultEngineId}".`,
  );
  return quarantine;
}

function getContextEngineQuarantine(engineId: string): ContextEngineRuntimeQuarantine | undefined {
  return getContextEngineRegistryState().quarantinedEngines.get(engineId);
}

export function listContextEngineQuarantines(): ContextEngineRuntimeQuarantine[] {
  const quarantines: ContextEngineRuntimeQuarantine[] = [];
  for (const entry of getContextEngineRegistryState().quarantinedEngines.values()) {
    const quarantine: ContextEngineRuntimeQuarantine = {
      engineId: entry.engineId,
      operation: entry.operation,
      reason: entry.reason,
      failedAt: new Date(entry.failedAt),
    };
    if (entry.owner) {
      quarantine.owner = entry.owner;
    }
    quarantines.push(quarantine);
  }
  return quarantines;
}

export function clearContextEngineRuntimeQuarantine(engineId?: string): void {
  const quarantinedEngines = getContextEngineRegistryState().quarantinedEngines;
  if (engineId === undefined) {
    quarantinedEngines.clear();
    return;
  }
  quarantinedEngines.delete(engineId);
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
  const normalizedOwner = requireContextEngineOwner(owner);
  const registry = getContextEngineRegistryState().engines;
  const existing = registry.get(id);
  if (
    id === defaultSlotIdForKey("contextEngine") &&
    normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER
  ) {
    return { ok: false, existingOwner: CORE_CONTEXT_ENGINE_OWNER };
  }
  if (existing && existing.owner !== normalizedOwner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing && opts?.allowSameOwnerRefresh !== true) {
    return { ok: false, existingOwner: existing.owner };
  }
  registry.set(id, { factory, owner: normalizedOwner });
  clearContextEngineRuntimeQuarantine(id);
  return { ok: true };
}

/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
export function registerContextEngine(
  id: string,
  factory: ContextEngineFactory,
): ContextEngineRegistrationResult {
  return registerContextEngineForOwner(id, factory, PUBLIC_CONTEXT_ENGINE_OWNER);
}

/**
 * Return the factory for a registered engine, or undefined.
 */
export function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return getContextEngineRegistryState().engines.get(id)?.factory;
}

/**
 * List all registered engine ids.
 */
export function listContextEngineIds(): string[] {
  return [...getContextEngineRegistryState().engines.keys()];
}

export function clearContextEnginesForOwner(owner: string): void {
  const normalizedOwner = requireContextEngineOwner(owner);
  const registryState = getContextEngineRegistryState();
  const registry = registryState.engines;
  for (const [id, entry] of registry.entries()) {
    if (entry.owner === normalizedOwner) {
      registry.delete(id);
      registryState.quarantinedEngines.delete(id);
    }
  }
}

/**
 * Return the trusted plugin id that registered a resolved context engine.
 */
export function resolveContextEngineOwnerPluginId(
  engine: ContextEngine | undefined | null,
): string | undefined {
  if (!engine) {
    return undefined;
  }
  const owner = resolveEffectiveContextEngineMetadata(engine)?.owner;
  if (!owner?.startsWith("plugin:")) {
    return undefined;
  }
  const pluginId = owner.slice("plugin:".length).trim();
  return pluginId || undefined;
}

function resolveEffectiveContextEngineMetadata(
  engine: ContextEngine,
): ResolvedContextEngineMetadata | undefined {
  const quarantineState = RUNTIME_QUARANTINE_PROXY_STATE.get(engine);
  if (quarantineState && getContextEngineQuarantine(quarantineState.engineId)) {
    const fallbackEngine = quarantineState.getResolvedFallbackEngine();
    return (
      (fallbackEngine ? RESOLVED_CONTEXT_ENGINE_METADATA.get(fallbackEngine) : undefined) ?? {
        owner: CORE_CONTEXT_ENGINE_OWNER,
      }
    );
  }
  return RESOLVED_CONTEXT_ENGINE_METADATA.get(engine);
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
    const infoRecord = info as Record<string, unknown>;
    // Engines own their internal info.id; it is metadata, not a handle into the
    // registry. The registered id (plugin slot id) and the engine's own id are
    // allowed to differ, so we only require that info.id is a non-empty string
    // for display/logging purposes and do not enforce equality with engineId.
    const infoId = typeof infoRecord.id === "string" ? infoRecord.id.trim() : "";
    if (!infoId) {
      issues.push("missing info.id");
    }
    if (typeof infoRecord.name !== "string" || !infoRecord.name.trim()) {
      issues.push("missing info.name");
    }
  }

  if (typeof candidate.ingest !== "function") {
    issues.push("missing ingest()");
  }
  if (typeof candidate.assemble !== "function") {
    issues.push("missing assemble()");
  }
  if (typeof candidate.compact !== "function") {
    issues.push("missing compact()");
  }

  if (issues.length === 0) {
    return null;
  }

  return `Context engine "${engineId}" factory returned an invalid ContextEngine: ${issues.join(", ")}.`;
}

type GuardedContextEngineMethodName =
  | "bootstrap"
  | "maintain"
  | "ingest"
  | "ingestBatch"
  | "afterTurn"
  | "assemble"
  | "compact"
  | "prepareSubagentSpawn"
  | "onSubagentEnded";

const GUARDED_CONTEXT_ENGINE_METHODS = new Set<PropertyKey>([
  "bootstrap",
  "maintain",
  "ingest",
  "ingestBatch",
  "afterTurn",
  "assemble",
  "compact",
  "prepareSubagentSpawn",
  "onSubagentEnded",
] satisfies GuardedContextEngineMethodName[]);

function contextEngineFallbackResult(
  methodName: GuardedContextEngineMethodName,
): BootstrapResult | ContextEngineMaintenanceResult | IngestResult | IngestBatchResult | void {
  switch (methodName) {
    case "bootstrap":
      return {
        bootstrapped: false,
        reason: "context engine downgraded to legacy",
      };
    case "maintain":
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "context engine downgraded to legacy",
      };
    case "ingest":
      return { ingested: false };
    case "ingestBatch":
      return { ingestedCount: 0 };
    case "afterTurn":
    case "prepareSubagentSpawn":
    case "onSubagentEnded":
      return undefined;
    case "assemble":
    case "compact":
      throw new Error(`No legacy fallback result for ${methodName}`);
  }
}

function contextEngineAbortSignal(methodParams: unknown): AbortSignal | undefined {
  if (!methodParams || typeof methodParams !== "object") {
    return undefined;
  }
  const signal = (methodParams as { abortSignal?: unknown }).abortSignal;
  if (signal && typeof signal === "object" && "aborted" in signal) {
    return signal as AbortSignal;
  }
  return undefined;
}

function contextEngineAbortError(methodParams: unknown): Error | undefined {
  const signal = contextEngineAbortSignal(methodParams);
  if (!signal?.aborted) {
    return undefined;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(
    typeof reason === "string" && reason ? reason : "Context engine operation aborted.",
  );
  error.name = "AbortError";
  return error;
}

function isContextEngineAbortRejection(error: unknown, methodParams: unknown): boolean {
  const signal = contextEngineAbortSignal(methodParams);
  if (!signal?.aborted) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      error.name === "AbortError" ||
      message.includes("abort") ||
      message.includes("cancelled") ||
      message.includes("canceled")
    );
  }
  return typeof error === "string" && /abort|cancelled|canceled/iu.test(error);
}

async function invokeFallbackContextEngineMethod(params: {
  getFallbackEngine: () => Promise<ContextEngine>;
  methodName: GuardedContextEngineMethodName;
  methodParams: unknown;
}): Promise<
  | AssembleResult
  | BootstrapResult
  | CompactResult
  | ContextEngineMaintenanceResult
  | IngestBatchResult
  | IngestResult
  | SubagentSpawnPreparation
  | void
> {
  const fallbackEngine = await params.getFallbackEngine();
  const fallbackMethod = fallbackEngine[params.methodName] as
    | ((methodParams: unknown) => unknown)
    | undefined;
  if (typeof fallbackMethod === "function") {
    return (await fallbackMethod.call(fallbackEngine, params.methodParams)) as
      | AssembleResult
      | BootstrapResult
      | CompactResult
      | ContextEngineMaintenanceResult
      | IngestBatchResult
      | IngestResult
      | SubagentSpawnPreparation
      | void;
  }
  return contextEngineFallbackResult(params.methodName);
}

function wrapContextEngineWithRuntimeQuarantine(params: {
  engine: ContextEngine;
  engineId: string;
  owner: string;
  defaultEngineId: string;
  factoryCtx: ContextEngineFactoryContext;
}): ContextEngine {
  let fallbackEnginePromise: Promise<ContextEngine> | undefined;
  let resolvedFallbackEngine: ContextEngine | undefined;
  const getFallbackEngine = () => {
    fallbackEnginePromise ??= resolveDefaultContextEngine(
      params.defaultEngineId,
      params.factoryCtx,
    ).then((engine) => {
      resolvedFallbackEngine = engine;
      return engine;
    });
    return fallbackEnginePromise;
  };
  const fallbackInfo = (): ContextEngineInfo => {
    return (
      resolvedFallbackEngine?.info ?? {
        id: params.defaultEngineId,
        name:
          params.defaultEngineId === "legacy"
            ? "Legacy Context Engine"
            : `${params.defaultEngineId} Context Engine`,
      }
    );
  };
  const isQuarantined = () => Boolean(getContextEngineQuarantine(params.engineId));

  const proxy = new Proxy(params.engine, {
    get(target, property, receiver) {
      if (property === "info" && isQuarantined()) {
        return fallbackInfo();
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !GUARDED_CONTEXT_ENGINE_METHODS.has(property)) {
        return typeof value === "function" ? value.bind(target) : value;
      }

      const methodName = property as GuardedContextEngineMethodName;
      return async (methodParams: unknown) => {
        const aborted = contextEngineAbortError(methodParams);
        if (aborted) {
          throw aborted;
        }
        if (isQuarantined()) {
          return await invokeFallbackContextEngineMethod({
            getFallbackEngine,
            methodName,
            methodParams,
          });
        }

        try {
          return await (value as (methodParams: unknown) => unknown).call(target, methodParams);
        } catch (error) {
          if (isContextEngineAbortRejection(error, methodParams)) {
            throw error;
          }
          recordContextEngineQuarantine({
            engineId: params.engineId,
            owner: params.owner,
            operation: methodName,
            error,
            defaultEngineId: params.defaultEngineId,
          });
          if (methodName === "compact" || methodName === "prepareSubagentSpawn") {
            throw error;
          }
          try {
            return await invokeFallbackContextEngineMethod({
              getFallbackEngine,
              methodName,
              methodParams,
            });
          } catch {
            throw error;
          }
        }
      };
    },
  });
  RUNTIME_QUARANTINE_PROXY_STATE.set(proxy, {
    engineId: params.engineId,
    getResolvedFallbackEngine: () => resolvedFallbackEngine,
  });
  return proxy;
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
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  const isDefaultEngine = engineId === defaultEngineId;

  const factoryCtx: ContextEngineFactoryContext = {
    config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
  };

  const quarantine = !isDefaultEngine ? getContextEngineQuarantine(engineId) : undefined;
  if (quarantine) {
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  const entry = getContextEngineRegistryState().engines.get(engineId);
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

  let engine: ContextEngine;
  try {
    engine = await entry.factory(factoryCtx);
  } catch (factoryError) {
    if (isDefaultEngine) {
      throw factoryError;
    }
    recordContextEngineQuarantine({
      engineId,
      owner: entry.owner,
      operation: "factory",
      error: factoryError,
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  let contractError: string | null;
  try {
    contractError = describeResolvedContextEngineContractError(engineId, engine);
  } catch (validationError) {
    if (isDefaultEngine) {
      throw validationError;
    }
    recordContextEngineQuarantine({
      engineId,
      owner: entry.owner,
      operation: "contract-validation",
      error: validationError,
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }
  if (contractError) {
    if (isDefaultEngine) {
      throw new Error(contractError);
    }
    recordContextEngineQuarantine({
      engineId,
      owner: entry.owner,
      operation: "contract-validation",
      error: contractError,
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
  const defaultEntry = getContextEngineRegistryState().engines.get(defaultEngineId);
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
