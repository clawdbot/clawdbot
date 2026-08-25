// Gateway early-startup runtime helpers.
// Starts discovery, remote skills, task maintenance, and delayed maintenance setup.
import { isNixMode } from "../config/paths.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type StartGatewayMaintenanceTimers =
  typeof import("./server-maintenance.js").startGatewayMaintenanceTimers;
type GatewayMaintenanceParams = Parameters<StartGatewayMaintenanceTimers>[0];

const loadRemoteSkillsRuntimeModule = async () => await import("../skills/runtime/remote.js");

/** Start plugin discovery and return the Bonjour shutdown callback when discovery is active. */
export async function startGatewayPluginDiscovery(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  gatewayDirectReachable: boolean;
  tailscaleMode: GatewayTailscaleMode;
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  pluginRegistry?: PluginRegistry;
  startupTrace?: GatewayStartupTrace;
}): Promise<(() => Promise<void>) | null> {
  if (params.minimalTestGateway) {
    return null;
  }
  const machineDisplayName = await measureStartup(
    params.startupTrace,
    "runtime.early.discovery.machine-name",
    async () => (await import("../infra/machine-name.js")).getMachineDisplayName(),
  );
  return await measureStartup(params.startupTrace, "runtime.early.discovery.start", async () => {
    const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");
    const discovery = await startGatewayDiscovery({
      machineDisplayName,
      port: params.port,
      gatewayTls: params.gatewayTls.enabled
        ? { enabled: true, fingerprintSha256: params.gatewayTls.fingerprintSha256 }
        : undefined,
      gatewayDirectReachable: params.gatewayDirectReachable,
      wideAreaDiscoveryEnabled: Boolean(params.cfgAtStart.discovery?.wideArea?.domain?.trim()),
      wideAreaDiscoveryDomain: params.cfgAtStart.discovery?.wideArea?.domain,
      tailscaleMode: params.tailscaleMode,
      mdnsMode: params.cfgAtStart.discovery?.mdns?.mode,
      gatewayDiscoveryServices: params.pluginRegistry?.gatewayDiscoveryServices,
      logDiscovery: params.logDiscovery,
    });
    return discovery.bonjourStop;
  });
}

/** Start early Gateway side runtimes before the main server is fully ready. */
export async function startGatewayEarlyRuntime(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  gatewayDirectReachable: boolean;
  tailscaleMode: GatewayTailscaleMode;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  nodeRegistry: Parameters<typeof import("../skills/runtime/remote.js").setSkillsRemoteRegistry>[0];
  swapBonjourStop: (next: (() => Promise<void>) | null) => (() => Promise<void>) | null;
  pluginRegistry?: PluginRegistry;
  broadcast: GatewayMaintenanceParams["broadcast"];
  nodeSendToAllSubscribed: Parameters<StartGatewayMaintenanceTimers>[0]["nodeSendToAllSubscribed"];
  getPresenceVersion: GatewayMaintenanceParams["getPresenceVersion"];
  getHealthVersion: GatewayMaintenanceParams["getHealthVersion"];
  refreshGatewayHealthSnapshot: GatewayMaintenanceParams["refreshGatewayHealthSnapshot"];
  restartRunningChannels: GatewayMaintenanceParams["restartRunningChannels"];
  refreshPresence: GatewayMaintenanceParams["refreshPresence"];
  resetEventLoopHealth: GatewayMaintenanceParams["resetEventLoopHealth"];
  logHealth: GatewayMaintenanceParams["logHealth"];
  dedupe: GatewayMaintenanceParams["dedupe"];
  chatAbortControllers: GatewayMaintenanceParams["chatAbortControllers"];
  chatQueuedTurns: GatewayMaintenanceParams["chatQueuedTurns"];
  restartRecoveryCandidates: GatewayMaintenanceParams["restartRecoveryCandidates"];
  chatRunState: GatewayMaintenanceParams["chatRunState"];
  removeChatRun: GatewayMaintenanceParams["removeChatRun"];
  agentRunSeq: GatewayMaintenanceParams["agentRunSeq"];
  nodeSendToSession: GatewayMaintenanceParams["nodeSendToSession"];
  mediaCleanupTtlMs?: number;
  skillsRefreshDelayMs: number;
  getSkillsRefreshTimer: () => ReturnType<typeof setTimeout> | null;
  setSkillsRefreshTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  getRuntimeConfig: () => OpenClawConfig;
  startupTrace?: GatewayStartupTrace;
}) {
  if (!params.minimalTestGateway) {
    await measureStartup(params.startupTrace, "runtime.early.task-state", async () => {
      const { ensureTaskRuntimeStateReady } = await import("../tasks/runtime-internal.js");
      ensureTaskRuntimeStateReady();
    });
  }
  // Startup failure can occur immediately after discovery; publish its owner first.
  params.swapBonjourStop(
    await measureStartup(params.startupTrace, "runtime.early.discovery", () =>
      startGatewayPluginDiscovery(params),
    ),
  );
  let getActiveTaskCount = () => 0;

  if (!params.minimalTestGateway) {
    const [{ primeRemoteSkillsCache, setSkillsRemoteRegistry }, taskRegistryMaintenance] =
      await measureStartup(params.startupTrace, "runtime.early.lazy-runtime-imports", () =>
        Promise.all([
          loadRemoteSkillsRuntimeModule(),
          import("../tasks/task-registry.maintenance.js"),
        ]),
      );
    setSkillsRemoteRegistry(params.nodeRegistry);
    void primeRemoteSkillsCache();
    // Task registry maintenance is authoritative in the Gateway process so
    // restart-blocker counts reflect the same live cron runtime.
    taskRegistryMaintenance.configureTaskRegistryMaintenance({
      runtimeAuthoritative: true,
    });
    taskRegistryMaintenance.startTaskRegistryMaintenance();
    getActiveTaskCount = () =>
      taskRegistryMaintenance.getInspectableActiveTaskRestartBlockers().length;
  }

  const skillsChangeUnsub = params.minimalTestGateway
    ? async () => {}
    : await measureStartup(params.startupTrace, "runtime.early.skills-listener", async () => {
        const skillsRuntimePromise = import("../skills/runtime/refresh.js");
        const remoteSkillsRuntimePromise = loadRemoteSkillsRuntimeModule();
        const { closeSkillsWatchers, registerSkillsChangeListener } = await skillsRuntimePromise;
        const { refreshRemoteBinsForConnectedNodes } = await remoteSkillsRuntimePromise;
        const unregister = registerSkillsChangeListener((event) => {
          if (event.reason === "remote-node") {
            // The snapshot invalidation runs after remote descriptors/bins change;
            // clients can now refetch authoritative skills.status without racing the probe.
            params.broadcast("skills.changed", { reason: event.reason });
            return;
          }
          // Coalesce local skill changes before refreshing connected remote
          // nodes so bulk plugin/skill updates do not stampede node refreshes.
          const existingTimer = params.getSkillsRefreshTimer();
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          const nextTimer = setTimeout(() => {
            params.setSkillsRefreshTimer(null);
            void refreshRemoteBinsForConnectedNodes(params.getRuntimeConfig()).then(
              () => {
                params.broadcast("skills.changed", { reason: event.reason });
              },
              (error: unknown) => {
                params.log.warn(
                  `failed to refresh remote bins after skills change: ${String(error)}`,
                );
                params.broadcast("skills.changed", { reason: event.reason });
              },
            );
          }, params.skillsRefreshDelayMs);
          params.setSkillsRefreshTimer(nextTimer);
        });
        return async () => {
          unregister();
          await closeSkillsWatchers();
        };
      });

  const startMaintenance = async () => {
    // Defer periodic maintenance until the caller has finished ready-state
    // wiring, but keep the lazy import owned by this early-runtime bundle.
    if (params.minimalTestGateway) {
      return null;
    }
    return await measureStartup(params.startupTrace, "post-ready.maintenance", async () => {
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      return startGatewayMaintenanceTimers({
        broadcast: params.broadcast,
        nodeSendToAllSubscribed: params.nodeSendToAllSubscribed,
        getPresenceVersion: params.getPresenceVersion,
        getHealthVersion: params.getHealthVersion,
        refreshGatewayHealthSnapshot: params.refreshGatewayHealthSnapshot,
        restartRunningChannels: params.restartRunningChannels,
        refreshPresence: params.refreshPresence,
        resetEventLoopHealth: params.resetEventLoopHealth,
        logHealth: params.logHealth,
        dedupe: params.dedupe,
        chatAbortControllers: params.chatAbortControllers,
        chatQueuedTurns: params.chatQueuedTurns,
        restartRecoveryCandidates: params.restartRecoveryCandidates,
        chatRunState: params.chatRunState,
        removeChatRun: params.removeChatRun,
        agentRunSeq: params.agentRunSeq,
        nodeSendToSession: params.nodeSendToSession,
        isNixMode,
        getRuntimeConfig: params.getRuntimeConfig,
        enableSkillCurator: true,
        ...(typeof params.mediaCleanupTtlMs === "number"
          ? { mediaCleanupTtlMs: params.mediaCleanupTtlMs }
          : {}),
      });
    });
  };

  return {
    getActiveTaskCount,
    skillsChangeUnsub,
    startMaintenance,
  };
}
