/**
 * Auth-profile source probes for runtime and persisted stores.
 * These checks intentionally avoid loading secret-bearing credential payloads.
 */
import fs from "node:fs";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  hasAnyRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import { readPersistedAuthProfileStateRaw, readPersistedAuthProfileStoreRaw } from "./sqlite.js";

// Auth-profile source checks look at runtime snapshots, JSON compatibility
// files, legacy files, and SQLite stores without materializing secret values.
function hasStoredAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

/** Returns true when any local/runtime/main auth profile source exists. */
export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasLocalAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }

  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (
    agentDir &&
    authPath !== mainAuthPath &&
    (hasStoredAuthProfileFiles(undefined) ||
      readPersistedAuthProfileStoreRaw(undefined) ||
      readPersistedAuthProfileStateRaw(undefined))
  ) {
    return true;
  }
  return false;
}

/** Returns true when the requested agent dir has a local auth profile source. */
export function hasLocalAuthProfileStoreSource(agentDir?: string): boolean {
  const runtimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (runtimeStore && Object.keys(runtimeStore.profiles).length > 0) {
    return true;
  }
  if (hasStoredAuthProfileFiles(agentDir)) {
    return true;
  }
  return Boolean(
    readPersistedAuthProfileStoreRaw(agentDir) || readPersistedAuthProfileStateRaw(agentDir),
  );
}
