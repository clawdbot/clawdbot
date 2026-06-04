import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import { resolveEffectiveOAuthCredential as resolveManagedOAuthCredential } from "./oauth-manager.js";
import type { OAuthCredential } from "./types.js";

/** Resolves the effective OAuth credential, optionally reading external CLI bootstrap state. */
export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential {
  return resolveManagedOAuthCredential({
    profileId: params.profileId,
    credential: params.credential,
    readBootstrapCredential: ({ profileId, credential }) =>
      readManagedExternalCliCredential({
        profileId,
        credential,
        allowKeychainPrompt: params.allowKeychainPrompt ?? false,
      }),
  });
}
