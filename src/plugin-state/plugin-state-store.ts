// Plugin state store exposes persisted per-plugin state operations.
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  clearPluginStateDatabaseForTests,
  closePluginStateDatabase,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  pluginStateClear,
  pluginStateConsume,
  pluginStateDelete,
  pluginStateDeleteIf,
  pluginStateEntries,
  pluginStateLookup,
  pluginStateRegister,
  pluginStateRegisterIfAbsent,
  pluginStateUpdate,
} from "./plugin-state-store.sqlite.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
  PluginStateOverflowPolicy,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

// Public plugin-state facade over the sqlite-backed store. It validates plugin
// ids, namespaces, JSON values, TTLs, and per-plugin limits before persistence.
// Public plugin-state facade over the sqlite-backed store. It validates plugin
// ids, namespaces, JSON values, TTLs, and per-plugin limits before persistence.
export type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";

export {
  closePluginStateDatabase,
  countPluginStateLiveEntries,
  isPluginStateDatabaseOpen,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.sqlite.js";

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const MAX_NAMESPACE_BYTES = 128;
const MAX_KEY_BYTES = 512;
const MAX_JSON_DEPTH = 64;

type StoreOptionSignature = {
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
};

type PreparedRegisterParams = {
  key: string;
  valueJson: string;
  ttlMs?: number;
};

const namespaceOptionSignatures = new Map<string, StoreOptionSignature>();
const textEncoder = new TextEncoder();

function invalidInput(
  message: string,
  operation: PluginStateStoreOperation = "register",
): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation,
  });
}

function assertMaxBytes(
  label: string,
  value: string,
  max: number,
  operation: PluginStateStoreOperation = "register",
): void {
  if (textEncoder.encode(value).byteLength > max) {
    throw invalidInput(`plugin state ${label} must be <= ${max} bytes`, operation);
  }
}

function validateNamespace(value: string, operation: PluginStateStoreOperation = "open"): string {
  const trimmed = value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw invalidInput(`plugin state namespace must be a safe path segment: ${value}`, operation);
  }
  assertMaxBytes("namespace", trimmed, MAX_NAMESPACE_BYTES, operation);
  return trimmed;
}

function validateKey(value: string, operation: PluginStateStoreOperation = "register"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw invalidInput("plugin state entry key must not be empty", operation);
  }
  assertMaxBytes("entry key", trimmed, MAX_KEY_BYTES, operation);
  return trimmed;
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput("plugin state maxEntries must be an integer >= 1", "open");
  }
  return value;
}

function validateOverflowPolicy(value: unknown): PluginStateOverflowPolicy {
  if (value === undefined || value === "evict-oldest") {
    return "evict-oldest";
  }
  if (value === "reject-new") {
    return value;
  }
  throw invalidInput("plugin state overflowPolicy must be evict-oldest or reject-new", "open");
}

function validateOptionalTtlMs(
  value: number | undefined,
  operation: PluginStateStoreOperation = "register",
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidInput("plugin state ttlMs must be a positive integer", operation);
  }
  return value;
}

function assertPlainJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  path: string,
  depth = 0,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new PluginStateStoreError(
      `plugin state value nesting exceeds maximum depth of ${MAX_JSON_DEPTH}`,
      { code: "PLUGIN_STATE_LIMIT_EXCEEDED", operation: "register" },
    );
  }
  if (value === null) {
    return;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return;
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput(`plugin state value at ${path} must be a finite number`);
    }
    return;
  }
  if (valueType !== "object") {
    throw invalidInput(`plugin state value at ${path} must be JSON-serializable`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw invalidInput(`plugin state value at ${path} must not contain circular references`);
  }
  seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw invalidInput(`plugin state array at ${path} must not be sparse`);
        }
        assertPlainJsonValue(value[index], seen, `${path}[${index}]`, depth + 1);
      }
      return;
    }

    if (Object.getPrototypeOf(objectValue) !== Object.prototype) {
      throw invalidInput(`plugin state object at ${path} must be a plain object`);
    }

    // Reject accessors, symbols, sparse arrays, and non-enumerable state so stored
    // values cannot execute code or round-trip differently through JSON.
    const descriptorEntries = Object.entries(Object.getOwnPropertyDescriptors(objectValue));
    const enumerableKeys = Object.keys(objectValue);
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw invalidInput(`plugin state object at ${path} must not use symbol keys`);
    }
    if (descriptorEntries.length !== enumerableKeys.length) {
      throw invalidInput(`plugin state object at ${path} must not use non-enumerable properties`);
    }
    for (const [key, descriptor] of descriptorEntries) {
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw invalidInput(`plugin state object at ${path}.${key} must use data properties`);
      }
      assertPlainJsonValue(descriptor.value, seen, `${path}.${key}`, depth + 1);
    }
  } finally {
    seen.delete(objectValue);
  }
}

function assertJsonSerializable(value: unknown): void {
  assertPlainJsonValue(value, new WeakSet<object>(), "value");
}

function assertValueSize(json: string): void {
  if (textEncoder.encode(json).byteLength > MAX_PLUGIN_STATE_VALUE_BYTES) {
    throw new PluginStateStoreError("plugin state value exceeds 64KB limit", {
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
    });
  }
}

function prepareRegisterParams(
  key: string,
  value: unknown,
  defaultTtlMs?: number,
  opts?: { ttlMs?: number },
): PreparedRegisterParams {
  const normalizedKey = validateKey(key, "register");
  assertJsonSerializable(value);
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw invalidInput("plugin state value must be JSON-serializable", "register");
  }
  assertValueSize(json);
  const ttlMs = validateOptionalTtlMs(opts?.ttlMs, "register") ?? defaultTtlMs;
  return {
    key: normalizedKey,
    valueJson: json,
    ...(ttlMs != null ? { ttlMs } : {}),
  };
}

function assertConsistentOptions(
  pluginId: string,
  namespace: string,
  signature: StoreOptionSignature,
): void {
  const key = `${pluginId}\0${namespace}`;
  const existing = namespaceOptionSignatures.get(key);
  if (!existing) {
    namespaceOptionSignatures.set(key, signature);
    return;
  }
  if (
    existing.maxEntries !== signature.maxEntries ||
    existing.overflowPolicy !== signature.overflowPolicy ||
    existing.defaultTtlMs !== signature.defaultTtlMs
  ) {
    // A namespace is a shared storage contract. Reopening it with different
    // limits would make eviction/TTL behavior depend on call order.
    throw invalidInput(
      `plugin state namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
      "open",
    );
  }
}

function createKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = validateOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  assertConsistentOptions(pluginId, namespace, { maxEntries, overflowPolicy, defaultTtlMs });

  return {
    async register(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      pluginStateRegister({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    async registerIfAbsent(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      return pluginStateRegisterIfAbsent({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    async update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return pluginStateUpdate({
        pluginId,
        namespace,
        key: normalizedKey,
        maxEntries,
        overflowPolicy,
        updateValueJson: (current) => {
          const next = updateValue(current as T | undefined);
          if (next === undefined) {
            return undefined;
          }
          const params = prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts);
          return {
            valueJson: params.valueJson,
            ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
          };
        },
        ...(env ? { env } : {}),
      });
    },
    async deleteIf(key, predicate) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDeleteIf({
        pluginId,
        namespace,
        key: normalizedKey,
        predicate: (current) => predicate(current as T),
        ...(env ? { env } : {}),
      });
    },
    async lookup(key) {
      const normalizedKey = validateKey(key, "lookup");
      return pluginStateLookup({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    async consume(key) {
      const normalizedKey = validateKey(key, "consume");
      return pluginStateConsume({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    async delete(key) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDelete({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      });
    },
    async entries() {
      return pluginStateEntries({
        pluginId,
        namespace,
        ...(env ? { env } : {}),
      }) as PluginStateEntry<T>[];
    },
    async clear() {
      pluginStateClear({ pluginId, namespace, ...(env ? { env } : {}) });
    },
  };
}

function createSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateSyncKeyedStore<T> {
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = validateOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  assertConsistentOptions(pluginId, namespace, { maxEntries, overflowPolicy, defaultTtlMs });

  return {
    register(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      pluginStateRegister({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    registerIfAbsent(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      return pluginStateRegisterIfAbsent({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return pluginStateUpdate({
        pluginId,
        namespace,
        key: normalizedKey,
        maxEntries,
        overflowPolicy,
        updateValueJson: (current) => {
          const next = updateValue(current as T | undefined);
          if (next === undefined) {
            return undefined;
          }
          const params = prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts);
          return {
            valueJson: params.valueJson,
            ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
          };
        },
        ...(env ? { env } : {}),
      });
    },
    deleteIf(key, predicate) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDeleteIf({
        pluginId,
        namespace,
        key: normalizedKey,
        predicate: (current) => predicate(current as T),
        ...(env ? { env } : {}),
      });
    },
    lookup(key) {
      const normalizedKey = validateKey(key, "lookup");
      return pluginStateLookup({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    consume(key) {
      const normalizedKey = validateKey(key, "consume");
      return pluginStateConsume({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    delete(key) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDelete({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      });
    },
    entries() {
      return pluginStateEntries({
        pluginId,
        namespace,
        ...(env ? { env } : {}),
      }) as PluginStateEntry<T>[];
    },
    clear() {
      pluginStateClear({ pluginId, namespace, ...(env ? { env } : {}) });
    },
  };
}

/** Opens an async plugin-state namespace for a non-core plugin id. */
export function createPluginStateKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options);
}

/** Opens a sync plugin-state namespace for a non-core plugin id. */
export function createPluginStateSyncKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginStateSyncKeyedStore<T> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createSyncKeyedStoreForPluginId<T>(pluginId, options);
}

/** Opens a sync plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateSyncKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): PluginStateSyncKeyedStore<T> {
  return createSyncKeyedStoreForPluginId<T>(options.ownerId, options);
}

/** Clears plugin-state rows and option signatures for tests. */
function clearPluginStateStoreForTests(): void {
  clearPluginStateDatabaseForTests();
  namespaceOptionSignatures.clear();
}

/** Resets plugin-state module/database state for isolated tests. */
export function resetPluginStateStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  if (options.closeDatabase !== false) {
    closePluginStateDatabase();
    closeOpenClawStateDatabaseForTest();
  }
  namespaceOptionSignatures.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.pluginStateStoreTestApi")] = {
    clearPluginStateStoreForTests,
  };
}
