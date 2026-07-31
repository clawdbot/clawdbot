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
  pluginStateRegisterSequencedJournalEntry,
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
  getPluginStateCapacity,
  isPluginStateDatabaseOpen,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  pluginStateEntriesInKeyRange,
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

type PluginStateImportEntry = {
  key: string;
  value: unknown;
  createdAt: number;
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

/** Atomically allocates a workspace sequence and appends one journal entry. */
export function registerPluginStateSyncSequencedJournalEntry(params: {
  pluginId: string;
  cursorOptions: OpenKeyedStoreOptions;
  cursorKey: string;
  journalOptions: OpenKeyedStoreOptions;
  initialSequence: number;
  journalKey: (sequence: number) => string;
  journalValue: (sequence: number) => unknown;
}): number {
  if (params.pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  if (!Number.isSafeInteger(params.initialSequence) || params.initialSequence < 0) {
    throw invalidInput("plugin state initial journal sequence must be a safe non-negative integer");
  }
  const cursorNamespace = validateNamespace(params.cursorOptions.namespace);
  const cursorMaxEntries = validateMaxEntries(params.cursorOptions.maxEntries);
  const cursorOverflowPolicy = validateOverflowPolicy(params.cursorOptions.overflowPolicy);
  const cursorDefaultTtlMs = validateOptionalTtlMs(params.cursorOptions.defaultTtlMs);
  const journalNamespace = validateNamespace(params.journalOptions.namespace);
  const journalMaxEntries = validateMaxEntries(params.journalOptions.maxEntries);
  const journalOverflowPolicy = validateOverflowPolicy(params.journalOptions.overflowPolicy);
  const journalDefaultTtlMs = validateOptionalTtlMs(params.journalOptions.defaultTtlMs);
  if (
    cursorOverflowPolicy !== "evict-oldest" ||
    journalOverflowPolicy !== "evict-oldest" ||
    cursorDefaultTtlMs !== undefined ||
    journalDefaultTtlMs !== undefined
  ) {
    throw invalidInput("sequenced plugin state journals require non-expiring evict-oldest stores");
  }
  if (params.cursorOptions.env !== params.journalOptions.env) {
    throw invalidInput("sequenced plugin state journal stores must share one environment");
  }
  const cursorKey = validateKey(params.cursorKey);
  assertConsistentOptions(params.pluginId, cursorNamespace, {
    maxEntries: cursorMaxEntries,
    overflowPolicy: cursorOverflowPolicy,
    defaultTtlMs: cursorDefaultTtlMs,
  });
  assertConsistentOptions(params.pluginId, journalNamespace, {
    maxEntries: journalMaxEntries,
    overflowPolicy: journalOverflowPolicy,
    defaultTtlMs: journalDefaultTtlMs,
  });
  return pluginStateRegisterSequencedJournalEntry({
    pluginId: params.pluginId,
    cursorNamespace,
    cursorKey,
    cursorMaxEntries,
    journalNamespace,
    journalMaxEntries,
    initialSequence: params.initialSequence,
    readCursorSequence(valueJson) {
      try {
        const value = JSON.parse(valueJson) as { kind?: unknown; lastSequence?: unknown };
        return value.kind === "cursor" && Number.isSafeInteger(value.lastSequence)
          ? (value.lastSequence as number)
          : undefined;
      } catch {
        return undefined;
      }
    },
    prepareEntry(sequence) {
      const cursor = prepareRegisterParams(cursorKey, { kind: "cursor", lastSequence: sequence });
      const journal = prepareRegisterParams(
        params.journalKey(sequence),
        params.journalValue(sequence),
      );
      return {
        cursorValueJson: cursor.valueJson,
        journalKey: journal.key,
        journalValueJson: journal.valueJson,
      };
    },
    ...(params.cursorOptions.env ? { env: params.cursorOptions.env } : {}),
  });
}

/** Doctor-only import that preserves source age and remaining retention. */
export function importPluginStateEntriesForDoctor(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  entries: readonly PluginStateImportEntry[],
): void {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = validateOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  assertConsistentOptions(pluginId, namespace, { maxEntries, overflowPolicy, defaultTtlMs });

  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.createdAt)) {
      throw invalidInput("plugin state import createdAt must be a safe integer", "register");
    }
    const prepared = prepareRegisterParams(
      entry.key,
      entry.value,
      defaultTtlMs,
      entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
    );
    pluginStateRegister({
      pluginId,
      namespace,
      key: prepared.key,
      valueJson: prepared.valueJson,
      maxEntries,
      overflowPolicy,
      createdAtMs: entry.createdAt,
      ...(env ? { env } : {}),
      ...(prepared.ttlMs != null ? { ttlMs: prepared.ttlMs } : {}),
    });
  }
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
