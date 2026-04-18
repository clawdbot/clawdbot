import { log } from "./constants.js";
import {
  hasUsableOAuthCredential,
  isSafeToUseExternalCliCredential,
  readExternalCliBootstrapCredential,
  shouldBootstrapFromExternalCliCredential,
} from "./external-cli-sync.js";
import type { OAuthCredential } from "./types.js";

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential {
  const imported = readExternalCliBootstrapCredential({
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    log.debug("resolved oauth credential from canonical local store", {
      profileId: params.profileId,
      provider: params.credential.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return params.credential;
  }
  if (!isSafeToUseExternalCliCredential(params.credential, imported)) {
    log.warn("refused external cli oauth bootstrap: identity mismatch", {
      profileId: params.profileId,
      provider: params.credential.provider,
    });
    return params.credential;
  }
  const shouldBootstrap = shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  });
  if (shouldBootstrap) {
    log.debug("resolved oauth credential from external cli bootstrap", {
      profileId: params.profileId,
      provider: imported.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return imported;
  }
  return params.credential;
}
