// Runtime store exports expose plugin runtime type contracts without loading runtime code.
export type { PluginRuntime } from "../plugins/runtime/types.js";
import { getNamedPluginRuntimeStoreSlot } from "./runtime-store-registry.js";
type PluginRuntimeStoreKeyOptions = {
  /** Explicit global registry key for shared runtime slots. */
  key: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};
type PluginRuntimeStorePluginOptions = {
  /** Plugin id used to derive a stable cross-module runtime slot key. */
  pluginId: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};
type PluginRuntimeStoreOptions = PluginRuntimeStoreKeyOptions | PluginRuntimeStorePluginOptions;

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

/**
 * Create a process-local runtime slot that throws when accessed before initialization.
 *
 * String keys create isolated module-local stores; option objects create global
 * named slots so duplicate SDK module instances share the same plugin runtime.
 */
export function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
/** Create a globally shared runtime slot keyed by plugin id or explicit registry key. */
export function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
/** Implementation overload accepting either legacy error-message strings or structured options. */
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
          // Store named slots on globalThis so duplicate SDK module instances
          // still share one runtime for the same plugin id or explicit key.
          return getNamedPluginRuntimeStoreSlot(resolved.key);
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
