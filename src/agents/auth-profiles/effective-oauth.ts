/**
 * Effective OAuth credential resolver.
 * Delegates to the managed OAuth selector while allowing external CLI
 * bootstrap credentials to fill unusable local profile state.
 */
import { readExternalCliBootstrapCredential } from "./external-cli-sync.js";
import { resolveEffectiveOAuthCredential as resolveManagedOAuthCredential } from "./oauth-manager.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

/** Resolves the effective OAuth credential, optionally reading external CLI bootstrap state. */
export function resolveEffectiveOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential {
  return resolveManagedOAuthCredential({
    store: params.store,
    profileId: params.profileId,
    credential: params.credential,
    readBootstrapCredential: ({ store, profileId, credential }) =>
      readExternalCliBootstrapCredential({
        store,
        profileId,
        credential,
        allowKeychainPrompt: params.allowKeychainPrompt ?? false,
      }),
  });
}
