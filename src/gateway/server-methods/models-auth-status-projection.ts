import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelAuthStatusProvider } from "./models-auth-status.types.js";

/**
 * A runtime-owned CLI credential is the fact for its canonical usage provider.
 * Do not publish an empty synthetic alias row that contradicts that credential
 * and forces each client surface to rediscover alias ownership independently.
 */
export function suppressSyntheticAliasRowsCoveredByExternalCli(
  providers: ModelAuthStatusProvider[],
  externalCliProfileIds: ReadonlySet<string>,
  legacyAliasProfileIds: ReadonlyMap<string, string>,
): ModelAuthStatusProvider[] {
  const ownedProfileIds = new Set(
    providers.flatMap((provider) =>
      provider.profiles
        .filter(
          (profile) => profile.type === "oauth" && externalCliProfileIds.has(profile.profileId),
        )
        .map((profile) => profile.profileId),
    ),
  );
  return providers.filter((provider) => {
    const legacyProfileId = legacyAliasProfileIds.get(normalizeProviderId(provider.provider));
    return !(
      provider.status === "missing" &&
      provider.profiles.length === 0 &&
      !provider.apiKey &&
      legacyProfileId !== undefined &&
      ownedProfileIds.has(legacyProfileId)
    );
  });
}
