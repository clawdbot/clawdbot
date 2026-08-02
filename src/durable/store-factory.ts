import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import type { DurableRuntimeReadStore, DurableRuntimeStore } from "./types.js";

export type OpenDurableRuntimeStoreOptions = {
  path?: string;
  env?: NodeJS.ProcessEnv;
};

export function openDurableRuntimeStore(
  options: OpenDurableRuntimeStoreOptions = {},
): DurableRuntimeStore {
  return openDurableRuntimeSqliteStore({ path: options.path, env: options.env });
}

export function openDurableRuntimeStoreReadOnly(
  options: OpenDurableRuntimeStoreOptions = {},
): DurableRuntimeReadStore {
  return openDurableRuntimeSqliteStore({
    path: options.path,
    env: options.env,
    readOnly: true,
  });
}
