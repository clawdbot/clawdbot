import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  getPreparedRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

type PreparedAuthStoreDeps = {
  loadDurable(input: PreparedModelRuntimeInput): AuthProfileStore;
  loadPublished(input: PreparedModelRuntimeInput): AuthProfileStore | undefined;
};

const defaultDeps: PreparedAuthStoreDeps = {
  loadDurable: (input) =>
    ensureAuthProfileStoreWithoutExternalProfiles(input.agentDir, {
      allowKeychainPrompt: false,
      ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
      readOnly: true,
    }),
  loadPublished: (input) =>
    getPreparedRuntimeAuthProfileStoreSnapshot(input.agentDir, input.inheritedAuthDir),
};

/** Merges runtime-only external auth over durable profiles for one replacement generation. */
export function loadPreparedModelRuntimeAuthStore(
  input: PreparedModelRuntimeInput,
  deps: PreparedAuthStoreDeps = defaultDeps,
): AuthProfileStore | undefined {
  const published = deps.loadPublished(input);
  if (
    !published ||
    (published.runtimeExternalProfileIds === undefined &&
      published.runtimeExternalProfileIdsAuthoritative !== true)
  ) {
    return undefined;
  }
  return mergeAuthProfileStores(deps.loadDurable(input), published);
}
