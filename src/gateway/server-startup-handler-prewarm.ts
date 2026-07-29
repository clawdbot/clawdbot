import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

const SIDEBAR_SESSION_LIST_LIMIT = 60;
const SIDEBAR_CATALOG_LIMIT_PER_HOST = 40;

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type GatewayHandlerPrewarmItem = {
  name: string;
  load: () => Promise<unknown>;
};

type GatewayHandlerPrewarmHandle = {
  stop: () => void;
};

async function prewarmGatewaySessionListData(cfg: OpenClawConfig, agentId: string): Promise<void> {
  const [{ loadCombinedSessionStoreForGateway }, { listSessionsFromStoreAsync }] =
    await Promise.all([
      import("../config/sessions/combined-store-gateway.js"),
      import("./session-utils-list.js"),
    ]);
  const { durableStorePath, storePath, store } = loadCombinedSessionStoreForGateway(cfg, {
    agentId,
    projection: "list",
  });
  await listSessionsFromStoreAsync({
    cfg,
    durableStorePath,
    storePath,
    store,
    opts: {
      agentId,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: SIDEBAR_SESSION_LIST_LIMIT,
    },
  });
}

function dashboardDataPrewarmItems(cfg: OpenClawConfig): GatewayHandlerPrewarmItem[] {
  const agentIds = listAgentIds(cfg);
  return [
    ...agentIds.map((agentId) => ({
      name: `sessions.${agentId}`,
      load: () => prewarmGatewaySessionListData(cfg, agentId),
    })),
    {
      name: "plugins",
      load: async () => {
        const { listManagedPlugins } = await import("../plugins/management-service.js");
        await listManagedPlugins({ config: cfg });
      },
    },
    ...agentIds.map((agentId) => ({
      name: `session-catalog.${agentId}`,
      load: async () => {
        const { prewarmSessionCatalogList } = await import("./server-methods/session-catalog.js");
        await prewarmSessionCatalogList({
          config: cfg,
          agentId,
          limitPerHost: SIDEBAR_CATALOG_LIMIT_PER_HOST,
        });
      },
    })),
  ];
}

export function scheduleGatewayHandlerPrewarm(params: {
  cfgAtStart: OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { warn: (msg: string) => void };
  items?: readonly GatewayHandlerPrewarmItem[];
}): GatewayHandlerPrewarmHandle {
  // Frequent updater restarts make cold dashboard data the remaining slow tier.
  // Keep cheap session reads first, process-stable plugin data second, and provider catalogs last.
  const items = params.items ?? dashboardDataPrewarmItems(params.cfgAtStart);
  let stopped = false;
  let nextIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    if (stopped || nextIndex >= items.length) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        return;
      }
      const item = items[nextIndex++];
      if (!item) {
        return;
      }
      const load = () => item.load();
      void runWithGatewayIndependentRootWorkAdmission(() =>
        params.startupTrace
          ? params.startupTrace.measure(`post-ready.gateway-data.${item.name}`, load)
          : load(),
      )
        .catch((err: unknown) => {
          // Prewarm only improves latency; readiness and request-time loaders remain authoritative.
          params.log.warn(
            `post-ready gateway data prewarm failed for ${item.name}: ${String(err)}`,
          );
        })
        .finally(scheduleNext);
    }, 0);
    timer.unref?.();
  };

  // One cache fill per event-loop turn lets immediate client work run between steps.
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
