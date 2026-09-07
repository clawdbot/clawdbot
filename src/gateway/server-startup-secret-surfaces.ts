import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";

export function resolveGatewayStartupSourceConfig(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): OpenClawConfig {
  const skipChannels =
    isTruthyEnvValue(env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}
