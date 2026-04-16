export type { PluginRuntime } from "../plugins/runtime/types.js";

const pluginRuntimeStoreRegistryKey = Symbol.for("openclaw.plugin-sdk.runtime-store-registry");

type PluginRuntimeStoreRegistry = Map<string, { runtime: unknown }>;
type PluginRuntimeStoreKeyOptions = {
  key: string;
  errorMessage: string;
};
type PluginRuntimeStorePluginOptions = {
  pluginId: string;
  errorMessage: string;
};
type PluginRuntimeStoreOptions = PluginRuntimeStoreKeyOptions | PluginRuntimeStorePluginOptions;

function getPluginRuntimeStoreRegistry(): PluginRuntimeStoreRegistry {
  const globalRecord = globalThis as typeof globalThis & {
    [pluginRuntimeStoreRegistryKey]?: PluginRuntimeStoreRegistry;
  };
  globalRecord[pluginRuntimeStoreRegistryKey] ??= new Map();
  return globalRecord[pluginRuntimeStoreRegistryKey];
}

function pluginRuntimeStoreKeyForPluginId(pluginId: string): string {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("createPluginRuntimeStore: pluginId must not be empty");
  }
  return `plugin-runtime:${normalizedPluginId}`;
}

function resolvePluginRuntimeStoreOptions(
  options: string | PluginRuntimeStoreOptions,
): PluginRuntimeStoreKeyOptions {
  if (typeof options === "string") {
    return { key: options, errorMessage: options };
  }
  if ("pluginId" in options) {
    return {
      key: pluginRuntimeStoreKeyForPluginId(options.pluginId),
      errorMessage: options.errorMessage,
    };
  }
  return options;
}

/** Create a tiny mutable runtime slot with strict access when the runtime has not been initialized. */
export function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
export function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
export function createPluginRuntimeStore<T>(options: string | PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  const resolved = resolvePluginRuntimeStoreOptions(options);
  const slot =
    typeof options === "string"
      ? { runtime: null }
      : (() => {
          const registry = getPluginRuntimeStoreRegistry();
          let existingSlot = registry.get(resolved.key);
          if (!existingSlot) {
            existingSlot = { runtime: null };
            registry.set(resolved.key, existingSlot);
          }
          return existingSlot;
        })();

  return {
    setRuntime(next: T) {
      slot.runtime = next;
    },
    clearRuntime() {
      slot.runtime = null;
    },
    tryGetRuntime() {
      return (slot.runtime as T | null) ?? null;
    },
    getRuntime() {
      if (slot.runtime === null) {
        throw new Error(resolved.errorMessage);
      }
      return slot.runtime as T;
    },
  };
}
