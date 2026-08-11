/** Classifies degradation state owned by provider and auth-profile refreshes. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

export type SecretsStateScope = "full" | "provider-auth";

export function listProviderAuthDegradedOwners(
  snapshot: PreparedSecretsRuntimeSnapshot,
): NonNullable<PreparedSecretsRuntimeSnapshot["degradedOwners"]> {
  const modelProviderOwnerIds = new Set(
    Object.keys(snapshot.sourceConfig.models?.providers ?? {}).map(
      (providerId) => normalizeOptionalLowercaseString(providerId) ?? providerId,
    ),
  );
  const authOwnerIds = new Set(
    snapshot.authStores.flatMap(({ agentDir, store }) =>
      Object.keys(store.profiles).map((profileId) =>
        resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
      ),
    ),
  );
  return (snapshot.degradedOwners ?? []).filter(
    (owner) =>
      (owner.ownerKind === "provider" && modelProviderOwnerIds.has(owner.ownerId)) ||
      (owner.ownerKind === "account" && authOwnerIds.has(owner.ownerId)),
  );
}

/** Whether a config-source repair may recover without replacing active auth-store state. */
export function preparedDegradationSupportsSourceOnlyRecovery(
  snapshot: PreparedSecretsRuntimeSnapshot,
): boolean {
  const degradedOwners = snapshot.degradedOwners ?? [];
  const authOwnerIds = new Set(
    snapshot.authStores.flatMap(({ agentDir, store }) =>
      Object.keys(store.profiles).map((profileId) =>
        resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
      ),
    ),
  );
  return (
    degradedOwners.length > 0 &&
    degradedOwners.every(
      (owner) =>
        owner.degradationState === "cold" &&
        !(owner.ownerKind === "account" && authOwnerIds.has(owner.ownerId)),
    )
  );
}

export function resolvePreparedSecretsStateScope(
  snapshot: PreparedSecretsRuntimeSnapshot,
): SecretsStateScope {
  const degradedOwners = snapshot.degradedOwners ?? [];
  return degradedOwners.length > 0 &&
    listProviderAuthDegradedOwners(snapshot).length === degradedOwners.length
    ? "provider-auth"
    : "full";
}
