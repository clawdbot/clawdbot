import { isDeepStrictEqual } from "node:util";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isSameOAuthRefreshGeneration } from "./oauth-refresh-marker.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import type { AuthProfileStore } from "./types.js";

export type PersistedAuthProfileStores = Readonly<{
  isMainStore: boolean;
  localStore: AuthProfileStore | null;
  mainStore: AuthProfileStore | null;
}>;

export function shouldUseMainOwnerForLocalOAuthCredential(params: {
  profileId: string;
  local: AuthProfileStore["profiles"][string];
  main: AuthProfileStore["profiles"][string] | undefined;
}): boolean {
  if (params.local.type !== "oauth" || params.main?.type !== "oauth") {
    return false;
  }
  // One single-use refresh generation has one durable owner even when access
  // tokens, identity metadata, or expiry drift between copied agent stores.
  if (
    isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.local,
      right: params.main,
    })
  ) {
    return true;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) {
    return false;
  }
  if (isDeepStrictEqual(params.local, params.main)) {
    return true;
  }
  const mainExpires = asDateTimestampMs(params.main.expires);
  if (mainExpires === undefined) {
    return false;
  }
  const localExpires = asDateTimestampMs(params.local.expires);
  return localExpires === undefined || mainExpires >= localExpires;
}

export function isInheritedMainOAuthCredentialFromStores(params: {
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  persistedStores: PersistedAuthProfileStores;
}): boolean {
  if (params.persistedStores.isMainStore || params.credential.type !== "oauth") {
    return false;
  }
  if (params.persistedStores.localStore?.profiles[params.profileId]) {
    return false;
  }
  const mainCredential = params.persistedStores.mainStore?.profiles[params.profileId];
  return (
    mainCredential?.type === "oauth" &&
    (isDeepStrictEqual(mainCredential, params.credential) ||
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: params.profileId,
        local: params.credential,
        main: mainCredential,
      }))
  );
}
