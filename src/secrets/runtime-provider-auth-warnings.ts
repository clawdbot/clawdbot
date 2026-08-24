/** Keeps provider-auth refresh warnings aligned with the state that refresh publishes. */
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import type { SecretResolverWarning } from "./runtime-shared.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

type ProviderAuthWarningSnapshot = Pick<
  PreparedSecretsRuntimeSnapshot,
  "authStores" | "degradedOwners" | "sourceConfig" | "warnings"
>;

function createProviderAuthRuntimeWarningMatcher(snapshot: ProviderAuthWarningSnapshot) {
  const authProfilePaths = new Set<string>();
  const authProfileOwnerIds = new Set<string>();
  for (const { agentDir, store } of snapshot.authStores) {
    for (const [profileId, profile] of Object.entries(store.profiles)) {
      const field = profile.type === "api_key" ? "key" : profile.type === "token" ? "token" : null;
      if (field === null) {
        continue;
      }
      authProfilePaths.add(`${agentDir}.auth-profiles.${profileId}.${field}`);
      authProfileOwnerIds.add(resolveAuthProfileSecretOwnerId({ agentDir, profileId }));
    }
  }

  const ownersByPath = new Map(
    (snapshot.degradedOwners ?? []).flatMap((owner) =>
      owner.paths.map((path) => [path, owner] as const),
    ),
  );
  const providerPathPrefixes = Object.keys(snapshot.sourceConfig.models?.providers ?? {}).map(
    (providerId) => `models.providers.${providerId}.`,
  );

  return (warning: SecretResolverWarning): boolean => {
    const owner = ownersByPath.get(warning.path);
    if (owner) {
      return (
        owner.ownerKind === "provider" ||
        (owner.ownerKind === "account" && authProfileOwnerIds.has(owner.ownerId))
      );
    }
    return (
      authProfilePaths.has(warning.path) ||
      providerPathPrefixes.some((prefix) => warning.path.startsWith(prefix))
    );
  };
}

export function mergeProviderAuthRuntimeWarnings(
  active: ProviderAuthWarningSnapshot,
  candidate: ProviderAuthWarningSnapshot,
): SecretResolverWarning[] {
  const isActiveProviderAuthWarning = createProviderAuthRuntimeWarningMatcher(active);
  const isCandidateProviderAuthWarning = createProviderAuthRuntimeWarningMatcher(candidate);
  return [
    ...active.warnings.filter((warning) => !isActiveProviderAuthWarning(warning)),
    ...candidate.warnings.filter(isCandidateProviderAuthWarning),
  ];
}
