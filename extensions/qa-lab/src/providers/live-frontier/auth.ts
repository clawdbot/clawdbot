import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyAuthProfileConfig,
  resolveEnvApiKey,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveQaAgentAuthDir, writeQaAuthProfiles } from "../shared/auth-store.js";

export const QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN";
export const QA_LIVE_SETUP_TOKEN_VALUE_ENV = "OPENCLAW_LIVE_SETUP_TOKEN_VALUE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID = "anthropic:qa-setup-token";
const QA_LIVE_API_KEY_AGENT_IDS = Object.freeze(["main", "qa"] as const);

function buildQaLiveApiKeyProfileId(provider: string): string {
  return `qa-live-${provider.replaceAll(/[^a-z0-9_-]/giu, "-")}-env`;
}

function resolveQaLiveAnthropicSetupToken(env: NodeJS.ProcessEnv = process.env) {
  const token = (
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV]?.trim() ||
    env[QA_LIVE_SETUP_TOKEN_VALUE_ENV]?.trim() ||
    ""
  ).replaceAll(/\s+/g, "");
  if (!token) {
    return null;
  }
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(`Invalid QA Anthropic setup-token: ${tokenError}`);
  }
  const profileId =
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV]?.trim() ||
    QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID;
  return { token, profileId };
}

export async function stageQaLiveAnthropicSetupToken(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const resolved = resolveQaLiveAnthropicSetupToken(params.env);
  if (!resolved) {
    return params.cfg;
  }
  await writeQaAuthProfiles({
    agentDir: resolveQaAgentAuthDir({ stateDir: params.stateDir, agentId: "main" }),
    profiles: {
      [resolved.profileId]: {
        type: "token",
        provider: "anthropic",
        token: resolved.token,
      },
    },
  });
  return applyAuthProfileConfig(params.cfg, {
    profileId: resolved.profileId,
    provider: "anthropic",
    mode: "token",
    displayName: "QA setup-token",
  });
}

export async function stageQaLiveApiKeyProfiles(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  agentIds?: readonly string[];
}): Promise<OpenClawConfig> {
  const env = params.env ?? process.env;
  const providerIds = [...new Set(params.providerIds.map((providerId) => providerId.trim()))]
    .filter((providerId) => providerId.length > 0)
    .toSorted();
  const profiles: Record<
    string,
    {
      type: "api_key";
      provider: string;
      key: string;
      displayName: string;
    }
  > = {};
  let next = params.cfg;
  for (const providerId of providerIds) {
    const resolved = resolveEnvApiKey(providerId, env, { config: next });
    if (!resolved?.apiKey) {
      continue;
    }
    const profileId = buildQaLiveApiKeyProfileId(providerId);
    const displayName = `QA live ${providerId} env credential`;
    profiles[profileId] = {
      type: "api_key",
      provider: providerId,
      key: resolved.apiKey,
      displayName,
    };
    next = applyAuthProfileConfig(next, {
      profileId,
      provider: providerId,
      mode: "api_key",
      displayName,
    });
  }
  if (Object.keys(profiles).length === 0) {
    return next;
  }
  const agentIds = [...new Set(params.agentIds ?? QA_LIVE_API_KEY_AGENT_IDS)];
  await Promise.all(
    agentIds.map((agentId) =>
      writeQaAuthProfiles({
        agentDir: resolveQaAgentAuthDir({ stateDir: params.stateDir, agentId }),
        profiles,
      }),
    ),
  );
  return next;
}
