// Gateway mutable runtime handles.
// Provides stop-safe defaults for timers, sidecars, subscriptions, and services.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

// Mutable server handles track timers, sidecars, subscriptions, and service
// cleanup hooks that shutdown/reload code must stop exactly once.
type GatewayConfigReloaderHandle = {
  stop: () => Promise<void>;
};

/** Mutable handles owned by a running gateway server process. */
export type GatewayServerMutableState = {
  bonjourStop: (() => Promise<void>) | null;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  heartbeatRunner: HeartbeatRunner;
  stopGatewayUpdateCheck: () => void;
  tailscaleCleanup: (() => Promise<void>) | null;
  postReadySidecars: GatewayPostReadySidecarHandle[];
  gatewayLifetimeSidecars: GatewayPostReadySidecarHandle[];
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

/** Creates gateway mutable state with inert handles that are safe to stop before startup finishes. */
export function createGatewayServerMutableState(): GatewayServerMutableState {
  const noopInterval = () => {
    // Dummy unref'd timers give shutdown code a concrete handle to clear even
    // when startup exits before real maintenance intervals are installed.
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
    postReadySidecars: [],
    gatewayLifetimeSidecars: [],
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
