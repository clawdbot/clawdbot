// Gateway mutable runtime handles.
// Provides stop-safe defaults for timers, sidecars, subscriptions, and services.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";
import {
  MEDIA_CLEANUP_STOP_TIMEOUT_MS,
  type MediaCleanupStopResult,
  waitForMediaCleanupDrains,
} from "./server-media-cleanup-lifecycle.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

// Mutable server handles track timers, sidecars, subscriptions, and service
// cleanup hooks that shutdown/reload code must stop exactly once.
// `hotReloadStatus` is omitted (not defaulted to "active") when no real
// watcher is running, so health can distinguish "no reloader" from "reloader
// active" instead of guessing.
export type GatewayConfigReloaderHandle = {
  stop: () => Promise<void>;
  hotReloadStatus?: () => GatewayHotReloadStatus;
  notifyPluginMetadataChanged: () => void;
};

/** Mutable handles owned by a running gateway server process. */
export type GatewayServerMutableState = {
  bonjourStop: (() => Promise<void>) | null;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  worktreeCleanup: ReturnType<typeof setInterval> | null;
  skillCuratorCleanup: () => void;
  heartbeatRunner: HeartbeatRunner;
  stopOutboundDeliveryRecovery: () => Promise<void>;
  stopGatewayUpdateCheck: () => void;
  tailscaleCleanup: (() => Promise<void>) | null;
  postReadySidecars: GatewayPostReadySidecarHandle[];
  gatewayLifetimeSidecars: GatewayPostReadySidecarHandle[];
  skillsRefreshTimer: ReturnType<typeof setTimeout> | null;
  skillsRefreshDelayMs: number;
  skillsChangeUnsub: () => Promise<void>;
  channelHealthMonitor: ChannelHealthMonitor | null;
  mcpServer: { port: number; close: () => Promise<void> } | undefined;
  configReloader: GatewayConfigReloaderHandle;
  agentUnsub: (() => Promise<void> | void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  taskUnsub: (() => void) | null;
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
    stopMediaCleanup: () => waitForMediaCleanupDrains({ timeoutMs: MEDIA_CLEANUP_STOP_TIMEOUT_MS }),
    worktreeCleanup: null as ReturnType<typeof setInterval> | null,
    skillCuratorCleanup: () => {},
    heartbeatRunner: {
      stop: () => {},
      updateConfig: (_cfg: OpenClawConfig) => {},
    } satisfies HeartbeatRunner,
    stopOutboundDeliveryRecovery: async () => {},
    stopGatewayUpdateCheck: () => {},
    tailscaleCleanup: null as (() => Promise<void>) | null,
    postReadySidecars: [],
    gatewayLifetimeSidecars: [],
    skillsRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    skillsRefreshDelayMs: 30_000,
    skillsChangeUnsub: async () => {},
    channelHealthMonitor: null as ChannelHealthMonitor | null,
    mcpServer: undefined as { port: number; close: () => Promise<void> } | undefined,
    configReloader: {
      stop: async () => {},
      notifyPluginMetadataChanged: () => {},
    } satisfies GatewayConfigReloaderHandle,
    agentUnsub: null as (() => Promise<void> | void) | null,
    heartbeatUnsub: null as (() => void) | null,
    transcriptUnsub: null as (() => void) | null,
    lifecycleUnsub: null as (() => void) | null,
    taskUnsub: null as (() => void) | null,
  };
}
