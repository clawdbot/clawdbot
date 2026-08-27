// Gateway mutable runtime handles.
// Provides stop-safe defaults for timers, sidecars, subscriptions, and services.
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { GatewayHotReloadStatus } from "./config-reload-status.types.js";
import {
  MEDIA_CLEANUP_STOP_TIMEOUT_MS,
  type MediaCleanupStopResult,
  waitForMediaCleanupDrains,
} from "./server-media-cleanup-lifecycle.js";
import { createNoopHeartbeatRunner } from "./server-runtime-service-shared.js";
import type { GatewayMaintenanceHandles } from "./server-runtime-services.js";
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
  maintenance: GatewayMaintenanceHandles | null;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
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
  configReloader: GatewayConfigReloaderHandle;
  agentUnsub: (() => Promise<void> | void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  taskUnsub: (() => void) | null;
};

/** Creates gateway mutable state with inert handles that are safe to stop before startup finishes. */
export function createGatewayServerMutableState(): GatewayServerMutableState {
  return {
    bonjourStop: null as (() => Promise<void>) | null,
    maintenance: null,
    stopMediaCleanup: () => waitForMediaCleanupDrains({ timeoutMs: MEDIA_CLEANUP_STOP_TIMEOUT_MS }),
    heartbeatRunner: createNoopHeartbeatRunner(),
    stopOutboundDeliveryRecovery: async () => {},
    stopGatewayUpdateCheck: () => {},
    tailscaleCleanup: null as (() => Promise<void>) | null,
    postReadySidecars: [],
    gatewayLifetimeSidecars: [],
    skillsRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    skillsRefreshDelayMs: 30_000,
    skillsChangeUnsub: async () => {},
    channelHealthMonitor: null as ChannelHealthMonitor | null,
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
