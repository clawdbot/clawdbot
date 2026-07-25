import type { AuthProfileStore } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { RuntimeAuthState } from "./helpers.js";

export function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ResolvedProviderAuth | null;
  runtimeAuthState: RuntimeAuthState | null;
}): string | undefined {
  if (params.runtimeAuthState) {
    return undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

export function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: string | undefined | string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((profileId) => profileId?.trim())
    .filter((profileId): profileId is string => Boolean(profileId));
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const scopedRuntimeExternalProfileIds = (store.runtimeExternalProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  const scopedRuntimePersistedProfileIds = (store.runtimePersistedProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : createEmptyAuthProfileStore();
}
