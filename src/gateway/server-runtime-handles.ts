import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";

type GatewayConfigReloaderHandle = {
  stop: () => Promise<void>;
};

export type GatewayServerMutableState = {
  bonjourStop: (() => Promise<void>) | null;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  heartbeatRunner: HeartbeatRunner;
  stopGatewayUpdateCheck: () => void;
  tailscaleCleanup: (() => Promise<void>) | null;
  skillsRefreshTimer: ReturnType<typeof setTimeout> | null;
  skillsRefreshDelayMs: number;
  skillsChangeUnsub: () => void;
  channelHealthMonitor: ChannelHealthMonitor | null;
  stopModelPricingRefresh: () => void;
  mcpServer: { port: number; close: () => Promise<void> } | undefined;
  configReloader: GatewayConfigReloaderHandle;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
};

export function createGatewayServerMutableState(): GatewayServerMutableState {
  const noopInterval = () => {
    const timer = setInterval(() => {}, 1 << 30);
    timer.unref?.();
    return timer;
  };
  return {
    bonjourStop: null as (() => Promise<void>) | null,
    tickInterval: noopInterval(),
    healthInterval: noopInterval(),
    dedupeCleanup: noopInterval(),
    mediaCleanup: null as ReturnType<typeof setInterval> | null,
    heartbeatRunner: {
      stop: () => {},
      updateConfig: (_cfg: OpenClawConfig) => {},
    } satisfies HeartbeatRunner,
    stopGatewayUpdateCheck: () => {},
    tailscaleCleanup: null as (() => Promise<void>) | null,
    skillsRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    skillsRefreshDelayMs: 30_000,
    skillsChangeUnsub: () => {},
    channelHealthMonitor: null as ChannelHealthMonitor | null,
    stopModelPricingRefresh: () => {},
    mcpServer: undefined as { port: number; close: () => Promise<void> } | undefined,
    configReloader: { stop: async () => {} } satisfies GatewayConfigReloaderHandle,
    agentUnsub: null as (() => void) | null,
    heartbeatUnsub: null as (() => void) | null,
    transcriptUnsub: null as (() => void) | null,
    lifecycleUnsub: null as (() => void) | null,
  };
}
