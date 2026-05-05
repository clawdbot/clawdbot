import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

type Awaitable<T> = T | Promise<T>;

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

type StartGatewayMaintenanceTimers =
  typeof import("./server-maintenance.js").startGatewayMaintenanceTimers;
type GatewayMaintenanceParams = Parameters<StartGatewayMaintenanceTimers>[0];

async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
}

export async function startGatewayPluginDiscovery(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
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
      wideAreaDiscoveryEnabled: params.cfgAtStart.discovery?.wideArea?.enabled === true,
      wideAreaDiscoveryDomain: params.cfgAtStart.discovery?.wideArea?.domain,
      tailscaleMode: params.tailscaleMode,
      mdnsMode: params.cfgAtStart.discovery?.mdns?.mode,
      gatewayDiscoveryServices: params.pluginRegistry?.gatewayDiscoveryServices,
      logDiscovery: params.logDiscovery,
    });
    return discovery.bonjourStop;
  });
}

export async function startGatewayEarlyRuntime(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  tailscaleMode: GatewayTailscaleMode;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  nodeRegistry: Parameters<typeof import("../infra/skills-remote.js").setSkillsRemoteRegistry>[0];
  pluginRegistry?: PluginRegistry;
  broadcast: GatewayMaintenanceParams["broadcast"];
  nodeSendToAllSubscribed: Parameters<StartGatewayMaintenanceTimers>[0]["nodeSendToAllSubscribed"];
  getPresenceVersion: GatewayMaintenanceParams["getPresenceVersion"];
  getHealthVersion: GatewayMaintenanceParams["getHealthVersion"];
  refreshGatewayHealthSnapshot: GatewayMaintenanceParams["refreshGatewayHealthSnapshot"];
  logHealth: GatewayMaintenanceParams["logHealth"];
  dedupe: GatewayMaintenanceParams["dedupe"];
  chatAbortControllers: GatewayMaintenanceParams["chatAbortControllers"];
  chatRunState: GatewayMaintenanceParams["chatRunState"];
  chatRunBuffers: GatewayMaintenanceParams["chatRunBuffers"];
  chatDeltaSentAt: GatewayMaintenanceParams["chatDeltaSentAt"];
  chatDeltaLastBroadcastLen: GatewayMaintenanceParams["chatDeltaLastBroadcastLen"];
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
  const bonjourStop = await measureStartup(params.startupTrace, "runtime.early.discovery", () =>
    startGatewayPluginDiscovery(params),
  );
  let getActiveTaskCount = () => 0;

  if (!params.minimalTestGateway) {
    const [{ primeRemoteSkillsCache, setSkillsRemoteRegistry }, taskRegistryMaintenance] =
      await measureStartup(params.startupTrace, "runtime.early.lazy-runtime-imports", () =>
        Promise.all([
          import("../infra/skills-remote.js"),
          import("../tasks/task-registry.maintenance.js"),
        ]),
      );
    setSkillsRemoteRegistry(params.nodeRegistry);
    void primeRemoteSkillsCache();
    taskRegistryMaintenance.configureTaskRegistryMaintenance({
      cronStorePath: resolveCronStorePath(params.cfgAtStart.cron?.store),
      cronRuntimeAuthoritative: true,
    });
    taskRegistryMaintenance.startTaskRegistryMaintenance();
    getActiveTaskCount = () =>
      taskRegistryMaintenance.getInspectableActiveTaskRestartBlockers().length;
  }

  const skillsChangeUnsub = params.minimalTestGateway
    ? () => {}
    : await measureStartup(params.startupTrace, "runtime.early.skills-listener", async () => {
        const [{ registerSkillsChangeListener }, { refreshRemoteBinsForConnectedNodes }] =
          await Promise.all([
            import("../agents/skills/refresh.js"),
            import("../infra/skills-remote.js"),
          ]);
        return registerSkillsChangeListener((event) => {
          if (event.reason === "remote-node") {
            return;
          }
          const existingTimer = params.getSkillsRefreshTimer();
          if (existingTimer) {
            clearTimeout(existingTimer);
          }
          const nextTimer = setTimeout(() => {
            params.setSkillsRefreshTimer(null);
            void refreshRemoteBinsForConnectedNodes(params.getRuntimeConfig());
          }, params.skillsRefreshDelayMs);
          params.setSkillsRefreshTimer(nextTimer);
        });
      });

  const startMaintenance = async () => {
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
        logHealth: params.logHealth,
        dedupe: params.dedupe,
        chatAbortControllers: params.chatAbortControllers,
        chatRunState: params.chatRunState,
        chatRunBuffers: params.chatRunBuffers,
        chatDeltaSentAt: params.chatDeltaSentAt,
        chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
        removeChatRun: params.removeChatRun,
        agentRunSeq: params.agentRunSeq,
        nodeSendToSession: params.nodeSendToSession,
        ...(typeof params.mediaCleanupTtlMs === "number"
          ? { mediaCleanupTtlMs: params.mediaCleanupTtlMs }
          : {}),
      });
    });
  };

  return {
    bonjourStop,
    getActiveTaskCount,
    skillsChangeUnsub,
    startMaintenance,
  };
}
