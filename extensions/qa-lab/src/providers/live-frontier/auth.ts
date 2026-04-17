import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  applyAuthProfileConfig,
  upsertAuthProfile,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";

export const QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN";
export const QA_LIVE_SETUP_TOKEN_VALUE_ENV = "OPENCLAW_LIVE_SETUP_TOKEN_VALUE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID = "anthropic:qa-setup-token";

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
  const agentDir = path.join(params.stateDir, "agents", "main", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  upsertAuthProfile({
    profileId: resolved.profileId,
    credential: {
      type: "token",
      provider: "anthropic",
      token: resolved.token,
    },
    agentDir,
  });
  return applyAuthProfileConfig(params.cfg, {
    profileId: resolved.profileId,
    provider: "anthropic",
    mode: "token",
    displayName: "QA setup-token",
  });
}
