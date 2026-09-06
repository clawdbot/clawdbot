import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth.js";
import type { ProviderAuthAliasLookupParams } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";

export function resolveConfigBoundProfileIds(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Set<string> {
  const profileIds = new Set<string>();
  for (const provider of Object.keys(cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg,
      authAliasLookupParams,
      provider,
      store,
    });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
    }
  }
  return profileIds;
}
