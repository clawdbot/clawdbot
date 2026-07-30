/** In-memory binding store helpers for Claude app-server tests. */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createClaudeAppServerBindingStore,
  type ClaudeAppServerBindingStore,
  type StoredClaudeAppServerBinding,
} from "./thread-store.js";

export function createClaudeTestBindingStateStore(): PluginStateSyncKeyedStore<StoredClaudeAppServerBinding> {
  const values = new Map<string, StoredClaudeAppServerBinding>();
  return {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
}

export function createClaudeTestBindingStore(): ClaudeAppServerBindingStore {
  return createClaudeAppServerBindingStore(createClaudeTestBindingStateStore());
}
