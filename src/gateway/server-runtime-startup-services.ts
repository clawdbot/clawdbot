// Gateway startup-time runtime services.
// Starts mode-dependent background monitors with inert handles for disabled paths.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import {
  createNoopHeartbeatRunner,
  type GatewayRuntimeServiceLogger,
} from "./server-runtime-service-shared.js";

// Runtime startup services start only the background services needed by the
// current gateway mode. Channel health is configurable; heartbeat/model pricing
// currently use inert handles here and are wired by other startup paths.
export type GatewayChannelManager = Parameters<
  typeof startChannelHealthMonitor
>[0]["channelManager"];

/** Starts channel health monitoring when gateway config enables it. */
export function startGatewayChannelHealthMonitor(params: {
  cfg: OpenClawConfig;
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

/** Starts background runtime services and returns their stop/update handles. */
export function startGatewayRuntimeServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  channelManager: GatewayChannelManager;
  log: GatewayRuntimeServiceLogger;
}): {
  heartbeatRunner: ReturnType<typeof createNoopHeartbeatRunner>;
  channelHealthMonitor: ChannelHealthMonitor | null;
  stopModelPricingRefresh: () => void;
} {
  const channelHealthMonitor = startGatewayChannelHealthMonitor({
    cfg: params.cfgAtStart,
    channelManager: params.channelManager,
  });

  return {
    heartbeatRunner: createNoopHeartbeatRunner(),
    channelHealthMonitor,
    stopModelPricingRefresh: () => {},
  };
}
