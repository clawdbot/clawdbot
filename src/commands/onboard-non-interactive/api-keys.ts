import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

export type NonInteractiveApiKeySource = "flag" | "env" | "profile";

async function resolveApiKeyFromProfiles(params: {
  provider: string;
  cfg: MoltbotConfig;
  agentDir?: string;
}): Promise<string | null> {
  const store = ensureAuthProfileStore(params.agentDir);
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  for (const profileId of order) {
    const cred = store.profiles[profileId];
    if (cred?.type !== "api_key") continue;
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) return resolved.apiKey;
  }
  return null;
}

export async function resolveNonInteractiveApiKey(params: {
  provider: string;
  cfg: MoltbotConfig;
  flagValue?: string;
  flagName: string;
  envVar: string;
  runtime: RuntimeEnv;
  agentDir?: string;
  allowProfile?: boolean;
  /** Optional validator function; returns error message or undefined if valid. */
  validate?: (key: string) => string | undefined;
}): Promise<{ key: string; source: NonInteractiveApiKeySource } | null> {
  const flagKey = params.flagValue?.trim();
  if (flagKey) {
    if (params.validate) {
      const error = params.validate(flagKey);
      if (error) {
        params.runtime.error(`Invalid ${params.flagName}: ${error}`);
        params.runtime.exit(1);
        return null;
      }
    }
    return { key: flagKey, source: "flag" };
  }

  const envResolved = resolveEnvApiKey(params.provider);
  if (envResolved?.apiKey) {
    if (params.validate) {
      const error = params.validate(envResolved.apiKey);
      if (error) {
        params.runtime.error(`Invalid ${params.envVar}: ${error}`);
        params.runtime.exit(1);
        return null;
      }
    }
    return { key: envResolved.apiKey, source: "env" };
  }

  if (params.allowProfile ?? true) {
    const profileKey = await resolveApiKeyFromProfiles({
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileKey) {
      if (params.validate) {
        const error = params.validate(profileKey);
        if (error) {
          params.runtime.error(`Invalid API key in ${params.provider} profile: ${error}`);
          params.runtime.exit(1);
          return null;
        }
      }
      return { key: profileKey, source: "profile" };
    }
  }

  const profileHint =
    params.allowProfile === false ? "" : `, or existing ${params.provider} API-key profile`;
  params.runtime.error(`Missing ${params.flagName} (or ${params.envVar} in env${profileHint}).`);
  params.runtime.exit(1);
  return null;
}
