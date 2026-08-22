// Github Copilot plugin module implements auth behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderPrepareDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { PROVIDER_ID } from "./models.js";

export async function resolveFirstGithubToken(params: {
  agentDir?: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  profileId?: string;
  authProfileMode?: ProviderPrepareDynamicModelContext["authProfileMode"];
}): Promise<{
  githubToken: string;
  hasProfile: boolean;
}> {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(authStore, PROVIDER_ID);
  const hasProfile = profileIds.length > 0;
  const requestedProfileId = params.profileId?.trim();
  const githubToken =
    [params.env.COPILOT_GITHUB_TOKEN, params.env.GH_TOKEN, params.env.GITHUB_TOKEN]
      .map((value) => normalizeOptionalSecretInput(value))
      .find((value) => value !== undefined) ?? "";
  const providerConfig = params.config?.models?.providers?.[PROVIDER_ID];
  const configuredRefCanOwnAuth =
    providerConfig?.auth === undefined ||
    providerConfig.auth === "api-key" ||
    providerConfig.auth === "token";
  const preferConfiguredToken =
    (configuredRefCanOwnAuth &&
      Boolean(coerceSecretRef(providerConfig?.apiKey, params.config?.secrets?.defaults))) ||
    (providerConfig?.auth === "api-key" &&
      Boolean(normalizeOptionalSecretInput(providerConfig.apiKey)));
  if (
    !requestedProfileId &&
    (params.authProfileMode || preferConfiguredToken || githubToken || !hasProfile)
  ) {
    // Prepared direct-auth attempts must not borrow a stored profile: model
    // limits and the later runtime exchange must use the same source token.
    if (githubToken && !preferConfiguredToken) {
      return { githubToken, hasProfile: false };
    }
    if (!params.config) {
      return { githubToken: "", hasProfile: false };
    }
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: params.config,
      env: params.env,
      value: configuredRefCanOwnAuth
        ? providerConfig?.apiKey
        : normalizeOptionalSecretInput(providerConfig?.apiKey),
      path: `models.providers.${PROVIDER_ID}.apiKey`,
      readFallback: () => "",
    });
    if (resolved.secretRefConfigured && !resolved.value) {
      throw new Error(
        resolved.unresolvedRefReason ??
          `models.providers.${PROVIDER_ID}.apiKey SecretRef is unresolved.`,
      );
    }
    return { githubToken: resolved.value?.trim() || githubToken, hasProfile: false };
  }

  const profileId = requestedProfileId
    ? profileIds.find((candidate) => candidate === requestedProfileId)
    : profileIds[0];
  const profile = profileId ? authStore.profiles[profileId] : undefined;
  if (profile?.type !== "token") {
    return { githubToken: "", hasProfile };
  }
  const resolved = await resolveRequiredConfiguredSecretRefInputString({
    config: params.config ?? {},
    env: params.env,
    value: profile.tokenRef,
    path: `providers.github-copilot.authProfiles.${profileId ?? "default"}.tokenRef`,
  });
  return { githubToken: (resolved ?? profile.token ?? "").trim(), hasProfile };
}
