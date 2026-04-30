import { AUTH_STORE_VERSION } from "./constants.js";
import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";

export type AuthProfilePortabilityReason =
  | "portable-static-credential"
  | "non-portable-oauth-refresh-token"
  | "credential-opted-out"
  | "oauth-provider-opted-in";

export type AuthProfilePortability = {
  portable: boolean;
  reason: AuthProfilePortabilityReason;
};

function hasAgentCopyOverride(credential: AuthProfileCredential): boolean | undefined {
  return typeof credential.copyToAgents === "boolean" ? credential.copyToAgents : undefined;
}

export function resolveAuthProfilePortability(
  credential: AuthProfileCredential,
): AuthProfilePortability {
  const override = hasAgentCopyOverride(credential);
  if (override === false) {
    return { portable: false, reason: "credential-opted-out" };
  }
  if (credential.type === "oauth") {
    return override === true
      ? { portable: true, reason: "oauth-provider-opted-in" }
      : { portable: false, reason: "non-portable-oauth-refresh-token" };
  }
  return { portable: true, reason: "portable-static-credential" };
}

export function isAuthProfileCredentialPortableForAgentCopy(
  credential: AuthProfileCredential,
): boolean {
  return resolveAuthProfilePortability(credential).portable;
}

export function buildPortableAuthProfileSecretsStoreForAgentCopy(store: AuthProfileStore): {
  store: AuthProfileSecretsStore;
  copiedProfileIds: string[];
  skippedProfileIds: string[];
} {
  const copiedProfileIds: string[] = [];
  const skippedProfileIds: string[] = [];
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, credential]) => {
      if (!isAuthProfileCredentialPortableForAgentCopy(credential)) {
        skippedProfileIds.push(profileId);
        return [];
      }
      copiedProfileIds.push(profileId);
      return [[profileId, credential]];
    }),
  ) as AuthProfileSecretsStore["profiles"];

  return {
    store: { version: AUTH_STORE_VERSION, profiles },
    copiedProfileIds,
    skippedProfileIds,
  };
}
