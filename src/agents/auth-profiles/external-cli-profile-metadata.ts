/** Canonical metadata for the legacy built-in Claude CLI auth profile slot. */
import type { AuthProfileConfig } from "../../config/types.auth.js";
import { CLAUDE_CLI_PROFILE_ID } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import type { AuthProfileCredential } from "./types.js";

type ExternalCliProfileMetadata = Pick<AuthProfileConfig, "provider" | "mode">;

const EXTERNAL_CLI_PROFILE_METADATA = new Map<
  string,
  {
    provider: string;
    legacyProviders: readonly string[];
  }
>([
  [CLAUDE_CLI_PROFILE_ID, { provider: "claude-cli", legacyProviders: ["anthropic", "claude-cli"] }],
]);

export function listExternalCliProfileMetadataIds(): string[] {
  return [...EXTERNAL_CLI_PROFILE_METADATA.keys()];
}

/**
 * Converts only the known pre-OAuth metadata spelling for a built-in CLI slot.
 * Other configured profiles remain user-owned and must never be reclassified.
 */
export function normalizeExternalCliProfileMetadata(
  profileId: string,
  profile: AuthProfileConfig | undefined,
): ExternalCliProfileMetadata | undefined {
  const definition = EXTERNAL_CLI_PROFILE_METADATA.get(profileId);
  if (!definition || !profile) {
    return undefined;
  }
  const provider = profile.provider.trim().toLowerCase();
  if (!definition.legacyProviders.includes(provider)) {
    return undefined;
  }
  if (profile.mode === "oauth") {
    return { provider: definition.provider, mode: "oauth" };
  }
  if (profile.mode === "token") {
    return { provider: definition.provider, mode: "oauth" };
  }
  return undefined;
}

export function listConfiguredExternalCliProfileMetadataIds(
  profiles: Record<string, AuthProfileConfig> | undefined,
): string[] {
  if (!profiles) {
    return [];
  }
  return listExternalCliProfileMetadataIds().filter((profileId) =>
    Boolean(normalizeExternalCliProfileMetadata(profileId, profiles[profileId])),
  );
}

/**
 * A persisted CLI credential can re-establish refresh ownership only when it
 * is current, bound to the expected CLI provider family, and identity-complete.
 */
export function isUsablePersistedExternalCliProfileCredential(
  profileId: string,
  credential: AuthProfileCredential | undefined,
): boolean {
  const definition = EXTERNAL_CLI_PROFILE_METADATA.get(profileId);
  if (!definition || credential?.type !== "oauth") {
    return false;
  }
  const provider = credential.provider.trim().toLowerCase();
  return (
    definition.legacyProviders.includes(provider) &&
    hasUsableOAuthCredential(credential) &&
    Boolean(credential.accountId?.trim() || credential.email?.trim())
  );
}
