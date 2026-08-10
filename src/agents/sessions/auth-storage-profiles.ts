/** Internal auth-profile sidecar for catalog request authentication. */
import type {
  ApiKeyCredential,
  AuthProfileStore,
  TokenCredential,
} from "../auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { resolveConfigValue } from "./resolve-config-value.js";

type MaterializedProfile =
  | (ApiKeyCredential & { key: string })
  | (TokenCredential & { token: string });
type StorageCredential =
  | { type: "api_key"; key: string }
  | { type: "token"; token: string; expires?: number }
  | { type: "oauth"; access: string; refresh: string; expires: number };
type ProfileData = Record<string, MaterializedProfile>;
type AuthStorageCredentialReader = { get(provider: string): StorageCredential | undefined };

const profileDataByStorage = new WeakMap<object, ProfileData>();
const runtimeOverrideByStorage = new WeakMap<object, (provider: string) => string | undefined>();
const credentialFreeStorage = new WeakSet<object>();
const liveDefaultStorage = new WeakSet<object>();

export function collectStateOnlyAuthProfileIds(store: AuthProfileStore): string[] {
  const referenced = new Set([
    ...Object.values(store.order ?? {}).flat(),
    ...Object.values(store.lastGood ?? {}),
    ...Object.keys(store.usageStats ?? {}),
  ]);
  return [...referenced].filter((profileId) => !store.profiles[profileId]);
}

export function hasUnmaterializedDefaultAuthProfileSecret(store: AuthProfileStore): boolean {
  return Object.entries(store.profiles).some(
    ([profileId, credential]) =>
      profileId === `${credential.provider}:default` &&
      ((credential.type === "api_key" && Boolean(credential.keyRef) && !credential.key) ||
        (credential.type === "token" && Boolean(credential.tokenRef) && !credential.token)),
  );
}

export function registerAuthStorageRuntimeOverride(
  storage: object,
  resolve: (provider: string) => string | undefined,
): void {
  runtimeOverrideByStorage.set(storage, resolve);
}

export function attachAuthStorageProfiles<T extends object>(
  storage: T,
  store: AuthProfileStore,
  options?: { liveDefault?: boolean },
): T {
  const profiles = Object.fromEntries(
    Object.entries(structuredClone(store.profiles)).filter(
      ([profileId, profile]) =>
        ((profile.type === "api_key" && Boolean(profile.key)) ||
          (profile.type === "token" && Boolean(profile.token))) &&
        (!options?.liveDefault || profileId !== `${profile.provider}:default`),
    ),
  ) as ProfileData;
  profileDataByStorage.set(storage, profiles);
  if (options?.liveDefault) {
    liveDefaultStorage.add(storage);
  }
  return storage;
}

export function copyAuthStorageProfiles(source: object, target: object): void {
  profileDataByStorage.set(target, structuredClone(profileDataByStorage.get(source) ?? {}));
}

function resolveProfile(
  storage: object,
  provider: string,
  profileId: string,
): ProfileData[string] | undefined {
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const liveDefault =
    liveDefaultStorage.has(storage) && profileId === `${provider}:default`
      ? (storage as AuthStorageCredentialReader).get(provider)
      : undefined;
  const profile =
    liveDefault?.type === "api_key" || liveDefault?.type === "token"
      ? ({ ...liveDefault, provider } as MaterializedProfile)
      : profileDataByStorage.get(storage)?.[profileId];
  return profile &&
    resolveProviderIdForAuth(profile.provider) === resolveProviderIdForAuth(provider)
    ? profile
    : undefined;
}

export function hasAuthStorageProfile(
  storage: object,
  provider: string,
  profileId: string,
  options?: { includeRuntimeOverride?: boolean },
): boolean {
  return Boolean(
    (options?.includeRuntimeOverride !== false &&
      runtimeOverrideByStorage.get(storage)?.(provider)) ||
    resolveProfile(storage, provider, profileId),
  );
}

export function resolveAuthStorageProfileApiKey(
  storage: object,
  provider: string,
  profileId: string,
): string | undefined {
  const runtimeOverride = runtimeOverrideByStorage.get(storage)?.(provider);
  if (runtimeOverride) {
    return runtimeOverride;
  }
  if (credentialFreeStorage.has(storage)) {
    return undefined;
  }
  const profile = resolveProfile(storage, provider, profileId);
  return profile?.type === "api_key"
    ? resolveConfigValue(profile.key)
    : profile?.type === "token" && (profile.expires === undefined || Date.now() < profile.expires)
      ? resolveConfigValue(profile.token)
      : undefined;
}

export function markAuthStorageCredentialFree<T extends object>(storage: T): T {
  credentialFreeStorage.add(storage);
  return storage;
}

export function isAuthStorageCredentialFree(storage: object): boolean {
  return credentialFreeStorage.has(storage);
}
