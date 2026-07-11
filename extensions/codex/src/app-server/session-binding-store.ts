/** Lazy store facade that keeps binding schema/auth code off plugin startup. */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
import type { CodexAppServerBindingStore, StoredCodexAppServerBinding } from "./session-binding.js";

export { CODEX_APP_SERVER_BINDING_MAX_ENTRIES, CODEX_APP_SERVER_BINDING_NAMESPACE };
export type { StoredCodexAppServerBinding } from "./session-binding.js";

/** Defers schema compilation and auth loading until the first binding operation. */
export function createLazyCodexAppServerBindingStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
    "entries" | "lookup" | "update"
  >,
): CodexAppServerBindingStore {
  let resolved: Promise<CodexAppServerBindingStore> | undefined;
  const store = () =>
    (resolved ??= import("./session-binding.js").then(({ createCodexAppServerBindingStore }) =>
      createCodexAppServerBindingStore(state),
    ));
  return {
    read: async (identity) => (await store()).read(identity),
    hasOtherThreadOwner: async (threadId, currentIdentity) =>
      (await store()).hasOtherThreadOwner(threadId, currentIdentity),
    mutate: async (identity, mutation) => (await store()).mutate(identity, mutation),
    prepareSessionGenerationReclaim: async (identity) =>
      (await store()).prepareSessionGenerationReclaim(identity),
    adoptSessionGeneration: async (identity, previousSessionId) =>
      (await store()).adoptSessionGeneration(identity, previousSessionId),
    retireSessionGeneration: async (identity) => (await store()).retireSessionGeneration(identity),
    withThreadArchiveFence: async (run) => (await store()).withThreadArchiveFence(run),
    withLease: async (identity, run) => (await store()).withLease(identity, run),
  };
}
