/**
 * Auth-profile source probes for runtime and persisted stores.
 * These checks intentionally avoid loading secret-bearing credential payloads.
 */
import fs from "node:fs";
import { evaluateStoredCredentialEligibility } from "./credential-state.js";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";
import { coerceLegacyAuthStore, coercePersistedAuthProfileStore } from "./persisted.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  hasAnyRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import { readPersistedAuthProfileStateRaw, readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

// Auth-profile source checks look at runtime snapshots, JSON compatibility
// files, legacy files, and SQLite stores without materializing secret values.
function hasStoredAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

function readJsonFile(pathname: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function isAuthProfileCredential(value: unknown): value is AuthProfileCredential {
  if (!value || typeof value !== "object") {
    return false;
  }
  const credential = value as { provider?: unknown; type?: unknown };
  const type = credential.type;
  return (
    typeof credential.provider === "string" &&
    (type === "api_key" || type === "token" || type === "oauth")
  );
}

function isEligibleProviderCredential(rawCredential: unknown, expectedProvider: string): boolean {
  if (!isAuthProfileCredential(rawCredential)) {
    return false;
  }
  return (
    normalizeProvider(rawCredential.provider) === expectedProvider &&
    evaluateStoredCredentialEligibility({ credential: rawCredential }).eligible
  );
}

function coerceRawStoreProfiles(raw: unknown): Record<string, AuthProfileCredential> | null {
  return coercePersistedAuthProfileStore(raw)?.profiles ?? coerceLegacyAuthStore(raw);
}

function rawStoreHasProviderProfile(
  raw: unknown,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const profiles = coerceRawStoreProfiles(raw);
  if (!profiles) {
    return false;
  }
  const expected = normalizeProvider(provider);
  const credentials =
    profileIds?.map((profileId) => profiles[profileId]) ?? Object.values(profiles);
  for (const rawCredential of credentials) {
    if (isEligibleProviderCredential(rawCredential, expected)) {
      return true;
    }
  }
  return false;
}

function runtimeStoreHasProviderProfile(
  store: AuthProfileStore | undefined,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  return rawStoreHasProviderProfile(store, provider, profileIds);
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

type AuthProfileSourceForProviderOptions = {
  /** Optional hard order/profile constraint from config auth.order. */
  profileIds?: readonly string[];
};

/** Returns true when a read-only auth-profile source contains a profile for a provider. */
export function hasAuthProfileStoreSourceForProvider(
  provider: string,
  agentDir?: string,
  options?: AuthProfileSourceForProviderOptions,
): boolean {
  if (!normalizeProvider(provider)) {
    return false;
  }
  const profileIds = options?.profileIds;
  if (profileIds?.length === 0) {
    return false;
  }
  const localRuntimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (runtimeStoreHasProviderProfile(localRuntimeStore, provider, profileIds)) {
    return true;
  }
  if (
    rawStoreHasProviderProfile(readJsonFile(resolveAuthStorePath(agentDir)), provider, profileIds)
  ) {
    return true;
  }
  if (
    rawStoreHasProviderProfile(
      readJsonFile(resolveLegacyAuthStorePath(agentDir)),
      provider,
      profileIds,
    )
  ) {
    return true;
  }
  if (
    rawStoreHasProviderProfile(readPersistedAuthProfileStoreRaw(agentDir), provider, profileIds)
  ) {
    return true;
  }

  if (!agentDir) {
    return false;
  }
  const mainRuntimeStore = getRuntimeAuthProfileStoreSnapshot();
  if (runtimeStoreHasProviderProfile(mainRuntimeStore, provider, profileIds)) {
    return true;
  }
  if (rawStoreHasProviderProfile(readJsonFile(resolveAuthStorePath()), provider, profileIds)) {
    return true;
  }
  if (
    rawStoreHasProviderProfile(readJsonFile(resolveLegacyAuthStorePath()), provider, profileIds)
  ) {
    return true;
  }
  return rawStoreHasProviderProfile(readPersistedAuthProfileStoreRaw(), provider, profileIds);
}
