import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveRequiredConfiguredSecretRefInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { PROVIDER_ID } from "./models.js";

export async function resolveFirstGithubToken(params: {
  agentDir?: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  githubToken: string;
  hasProfile: boolean;
}> {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(authStore, PROVIDER_ID);
  const hasProfile = profileIds.length > 0;
  const envToken =
    params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "";
  const githubToken = envToken.trim();
  if (githubToken || !hasProfile) {
    return { githubToken, hasProfile };
  }

  const profileId = profileIds[0];
  const profile = profileId ? authStore.profiles[profileId] : undefined;
  if (profile?.type !== "token") {
    return { githubToken: "", hasProfile };
  }
  const directToken = profile.token?.trim() ?? "";
  if (directToken) {
    return { githubToken: directToken, hasProfile };
  }
  const tokenRef = coerceSecretRef(profile.tokenRef);
  if (tokenRef?.source === "env" && tokenRef.id.trim()) {
    return {
      githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
      hasProfile,
    };
  }

  if (tokenRef && params.config) {
    try {
      const resolved = await resolveRequiredConfiguredSecretRefInputString({
        config: params.config,
        env: params.env,
        value: profile.tokenRef,
        path: `providers.github-copilot.authProfiles.${profileId ?? "default"}.tokenRef`,
      });
      return {
        githubToken: resolved?.trim() ?? "",
        hasProfile,
      };
    } catch {
      return { githubToken: "", hasProfile };
    }
  }

  return { githubToken: "", hasProfile };
}
