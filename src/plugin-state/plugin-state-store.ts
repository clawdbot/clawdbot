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
import {
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
} from "./plugin-store-validation.js";

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
  resolveMaxPluginStateEntriesPerPlugin,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.sqlite.js";

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
function invalidInput(
  message: string,
  operation: PluginStateStoreOperation = "register",
): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation,
  });
}

function validateNamespace(value: string, operation: PluginStateStoreOperation = "open"): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function validateKey(value: string, operation: PluginStateStoreOperation = "register"): string {
  return validatePluginStoreKey({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
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
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin state ttlMs",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function prepareRegisterParams(
  key: string,
  value: unknown,
  defaultTtlMs?: number,
  opts?: { ttlMs?: number },
): PreparedRegisterParams {
  const normalizedKey = validateKey(key, "register");
  const json = serializePluginStoreJson({
    value,
    label: "plugin state value",
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
    errors: {
      invalid: (message) => invalidInput(message, "register"),
      limit: (message) =>
        new PluginStateStoreError(message, {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
    },
  });
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

/**
 * Migration-only write path that preserves a legacy entry's original creation
 * timestamp. Cap eviction removes the oldest `created_at` first, so imported
 * rows must keep their real age instead of being stamped with the import time
 * (which would let later live writes evict fresher pre-existing rows first).
 * Not part of the plugin-facing store API.
 */
export function registerMigratedPluginStateEntry(params: {
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy?: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
  key: string;
  value: unknown;
  ttlMs?: number;
  createdAtMs: number;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!Number.isFinite(params.createdAtMs) || params.createdAtMs < 0) {
    throw invalidInput("plugin state migration createdAtMs must be a non-negative finite number");
  }
  const namespace = validateNamespace(params.namespace, "register");
  const maxEntries = validateMaxEntries(params.maxEntries);
  const overflowPolicy = validateOverflowPolicy(params.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(params.defaultTtlMs);
  const prepared = prepareRegisterParams(
    params.key,
    params.value,
    defaultTtlMs,
    params.ttlMs != null ? { ttlMs: params.ttlMs } : undefined,
  );
  pluginStateRegister({
    pluginId: params.pluginId,
    namespace,
    key: prepared.key,
    valueJson: prepared.valueJson,
    maxEntries,
    overflowPolicy,
    createdAtMs: Math.floor(params.createdAtMs),
    ...(params.env ? { env: params.env } : {}),
    ...(prepared.ttlMs != null ? { ttlMs: prepared.ttlMs } : {}),
  });
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
