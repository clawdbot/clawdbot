import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import { resolveEffectiveOAuthCredential as resolveManagedOAuthCredential } from "./oauth-manager.js";
import type { OAuthCredential } from "./types.js";

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential {
  return resolveManagedOAuthCredential({
    profileId: params.profileId,
    credential: params.credential,
    readBootstrapCredential: ({ profileId, credential }) =>
      readManagedExternalCliCredential({
        profileId,
        credential,
      }),
  });
}
