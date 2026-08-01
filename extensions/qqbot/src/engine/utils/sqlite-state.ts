// Qqbot plugin module implements sqlite state behavior.
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { getQQBotRuntime } from "../../bridge/runtime.js";
export { buildQQBotStateKey } from "./state-keys.js";

type QQBotSyncStoreOptions = OpenKeyedStoreOptions & {
  stateDir?: string;
};

function resolveStoreEnv(options: QQBotSyncStoreOptions): NodeJS.ProcessEnv | undefined {
  if (!options.stateDir) {
    return options.env;
  }
  return {
    ...(options.env ?? process.env),
    OPENCLAW_STATE_DIR: options.stateDir,
  };
}

export function openQQBotSyncKeyedStore<T>(
  options: QQBotSyncStoreOptions,
): PluginStateSyncKeyedStore<T> {
  return getQQBotRuntime().state.openSyncKeyedStore<T>({
    namespace: options.namespace,
    maxEntries: options.maxEntries,
    ...(options.defaultTtlMs != null ? { defaultTtlMs: options.defaultTtlMs } : {}),
    ...(resolveStoreEnv(options) ? { env: resolveStoreEnv(options) } : {}),
  });
}
