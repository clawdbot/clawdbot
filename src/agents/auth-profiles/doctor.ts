/**
 * Provider-specific auth doctor hints.
 * Adds local migration guidance for known legacy profiles before falling back
 * to provider plugin doctor copy.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProviderAuthDoctorHintWithPlugin } from "../../plugins/provider-runtime.runtime.js";
import type { AuthProfileStore } from "./types.js";

const QWEN_PORTAL_OAUTH_MIGRATION_HINT =
  "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current portal token: openclaw onboard --auth-choice qwen-oauth.";

// Qwen Portal OAuth changed credential behavior; old profiles need an explicit
// local hint before falling back to provider plugin doctor hints.
function hasLegacyQwenPortalOAuthProfile(store: AuthProfileStore, profileId?: string): boolean {
  const profiles = profileId ? [store.profiles[profileId]] : Object.values(store.profiles);
  return profiles.some(
    (profile) =>
      profile?.type === "oauth" && normalizeProviderId(profile.provider) === "qwen-portal",
  );
}

type FormatAuthDoctorHintParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
};

// Keep local short-circuits and the plugin fallback in one seam so focused tests
// can prove their ordering without loading the full provider runtime.
async function formatAuthDoctorHintWithPluginBuilder(
  params: FormatAuthDoctorHintParams,
  buildPluginHint: typeof buildProviderAuthDoctorHintWithPlugin,
): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (
    normalizedProvider === "qwen-portal" &&
    hasLegacyQwenPortalOAuthProfile(params.store, params.profileId)
  ) {
    return QWEN_PORTAL_OAUTH_MIGRATION_HINT;
  }

  const pluginHint = await buildPluginHint({
    provider: normalizedProvider,
    context: {
      config: params.cfg,
      store: params.store,
      provider: normalizedProvider,
      profileId: params.profileId,
    },
  });
  if (typeof pluginHint === "string" && pluginHint.trim()) {
    return pluginHint;
  }
  return "";
}

/** Formats provider-specific auth doctor guidance for a profile/store. */
export async function formatAuthDoctorHint(params: FormatAuthDoctorHintParams): Promise<string> {
  return await formatAuthDoctorHintWithPluginBuilder(params, buildProviderAuthDoctorHintWithPlugin);
}
