// Gateway startup-time runtime services.
// Starts mode-dependent background monitors for enabled channel paths.
import { isTruthyEnvValue } from "../infra/env.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";

export type GatewayChannelManager = Parameters<
  typeof startChannelHealthMonitor
>[0]["channelManager"];

/** Starts channel health monitoring unless process configuration suppresses channels. */
export function startGatewayChannelHealthMonitor(params: {
  channelManager: GatewayChannelManager;
  env?: NodeJS.ProcessEnv;
}): ChannelHealthMonitor | null {
  const env = params.env ?? process.env;
  // Process-level channel suppression also owns recovery: otherwise the health
  // monitor restarts configured transports after the startup grace period.
  if (
    isTruthyEnvValue(env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(env.OPENCLAW_SKIP_PROVIDERS)
  ) {
    return null;
  }
  return startChannelHealthMonitor({
    channelManager: params.channelManager,
  });
}
