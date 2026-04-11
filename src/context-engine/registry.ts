import type { OpenClawConfig } from "../config/types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ContextEngine } from "./types.js";

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
};

const LEGACY_SESSION_KEY_COMPAT = Symbol.for("openclaw.contextEngine.sessionKeyCompat");
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

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";
const PUBLIC_CONTEXT_ENGINE_OWNER = "public-sdk";

type ContextEngineRegistryState = {
  engines: Map<
    string,
    {
      factory: ContextEngineFactory;
      owner: string;
    }
  >;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    engines: new Map(),
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

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * Throws if the resolved engine id has no registered factory.
 */
export async function resolveContextEngine(config?: OpenClawConfig): Promise<ContextEngine> {
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  const entry = getContextEngineRegistryState().engines.get(engineId);
  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  return wrapContextEngineWithSessionKeyCompat(await entry.factory());
}
