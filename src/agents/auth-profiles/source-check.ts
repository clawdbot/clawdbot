/**
 * Auth-profile source probes for runtime and persisted stores.
 * These checks intentionally avoid loading secret-bearing credential payloads.
 */
import { evaluateStoredCredentialEligibility } from "./credential-state.js";
import { hasLegacyAuthProfileCredentialSource } from "./legacy-source-diagnostic.js";
import { coercePersistedAuthProfileStore } from "./persisted.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  hasAnyRuntimeAuthProfileStoreSource,
} from "./runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
} from "./sqlite.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

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
  return coercePersistedAuthProfileStore(raw)?.profiles ?? null;
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

function canonicalStoreOwnsProviderRoute(
  agentDir: string | undefined,
  provider: string,
  profileIds?: readonly string[],
): boolean {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  if (inspection.status === "missing") {
    return false;
  }
  if (inspection.status === "unreadable" || !coercePersistedAuthProfileStore(inspection.raw)) {
    // A present but unreadable canonical row must route through the loader so
    // AUTH_PROFILE_STORE_UNREADABLE fails closed before env/config fallback.
    return true;
  }
  return rawStoreHasProviderProfile(inspection.raw, provider, profileIds);
}

/** Returns true when any local/runtime/main auth profile source exists. */
export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasLocalAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }

  const authPath = resolveAuthProfileDatabasePath(agentDir);
  const mainAuthPath = resolveAuthProfileDatabasePath();
  if (
    agentDir &&
    authPath !== mainAuthPath &&
    (hasLegacyAuthProfileCredentialSource(undefined) ||
      inspectPersistedAuthProfileStoreRaw(undefined).status !== "missing" ||
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
  if (hasLegacyAuthProfileCredentialSource(agentDir)) {
    return true;
  }
  if (inspectPersistedAuthProfileStoreRaw(agentDir).status !== "missing") {
    return true;
  }
  return Boolean(readPersistedAuthProfileStateRaw(agentDir));
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
  // A retired credential source is intentionally opaque to runtime. Treat it
  // as potentially owning the provider so the canonical loader can fail closed
  // with AUTH_PROFILE_MIGRATION_REQUIRED instead of falling through to env auth.
  if (hasLegacyAuthProfileCredentialSource(agentDir)) {
    return true;
  }
  if (canonicalStoreOwnsProviderRoute(agentDir, provider, profileIds)) {
    return true;
  }

  if (!agentDir) {
    return false;
  }
  const mainRuntimeStore = getRuntimeAuthProfileStoreSnapshot();
  if (runtimeStoreHasProviderProfile(mainRuntimeStore, provider, profileIds)) {
    return true;
  }
  if (hasLegacyAuthProfileCredentialSource()) {
    return true;
  }
  return canonicalStoreOwnsProviderRoute(undefined, provider, profileIds);
}
