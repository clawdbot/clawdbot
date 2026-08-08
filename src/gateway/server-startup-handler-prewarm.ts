import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";

const SIDEBAR_SESSION_LIST_LIMIT = 60;
const SIDEBAR_PREWARM_MAX_SESSION_ENTRIES = 2_000;
const GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS = 250;

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

function dashboardDataPrewarmItems(
  cfg: OpenClawConfig,
  log: { info?: (msg: string) => void },
): GatewayHandlerPrewarmItem[] {
  const agentIds = listAgentIds(cfg);
  let sessionDataPrewarmChecked = false;
  let sessionDataPrewarmAllowed = false;
  const shouldPrewarmSessionData = async () => {
    if (sessionDataPrewarmChecked) {
      return sessionDataPrewarmAllowed;
    }
    sessionDataPrewarmChecked = true;
    const { canPrewarmCombinedSessionStoresForGateway } =
      await import("../config/sessions/combined-store-gateway.js");
    sessionDataPrewarmAllowed = canPrewarmCombinedSessionStoresForGateway(cfg, {
      agentIds,
      maxRows: SIDEBAR_PREWARM_MAX_SESSION_ENTRIES,
    });
    if (!sessionDataPrewarmAllowed) {
      log.info?.(
        `skipping optional dashboard session prewarm: combined stores exceed ${SIDEBAR_PREWARM_MAX_SESSION_ENTRIES} rows`,
      );
    }
    return sessionDataPrewarmAllowed;
  };
  return [
    ...agentIds.map((agentId) => ({
      name: `sessions.${agentId}`,
      load: async () => {
        // A count-only query keeps unusually large stores off the synchronous JSON projection
        // path. The request-time session handler remains authoritative when skipped.
        if (!(await shouldPrewarmSessionData())) {
          return;
        }
        await prewarmGatewaySessionListData(cfg, agentId);
      },
    })),
    {
      name: "plugins",
      load: async () => {
        const { listManagedPlugins } = await import("../plugins/management-service.js");
        await listManagedPlugins({ config: cfg });
      },
    },
  ];
}

export function scheduleGatewayHandlerPrewarm(params: {
  cfgAtStart: OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
  items?: readonly GatewayHandlerPrewarmItem[];
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayHandlerPrewarmHandle {
  // Frequent updater restarts make cold dashboard data the remaining slow tier.
  // Keep bounded session reads first and process-stable plugin data second.
  // Provider catalogs stay request-driven because their adapters may do unbounded external work.
  const items = params.items ?? dashboardDataPrewarmItems(params.cfgAtStart, params.log);
  let stopped = false;
  let nextIndex = 0;
  let currentItemName = "unknown";
  let idleTask: GatewayIdleTaskHandle | undefined;

  const scheduleNext = () => {
    if (stopped || nextIndex >= items.length) {
      return;
    }
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (stopped) {
        return;
      }
      const item = items[nextIndex++];
      if (!item) {
        return;
      }
      currentItemName = item.name;
      const load = () => item.load();
      idleTask = scheduleGatewayIdleTask({
        delayMs: 0,
        retryDelayMs: GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS,
        isClosing: () => stopped,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        run: async () => {
          try {
            await (params.startupTrace
              ? params.startupTrace.measure(`post-ready.gateway-data.${item.name}`, load)
              : load());
          } finally {
            idleTask = undefined;
            scheduleNext();
          }
        },
        log: params.log,
        // Prewarm only improves latency; readiness and request-time loaders remain authoritative.
        errorMessage: `post-ready gateway data prewarm failed for ${item.name}`,
      });
    })().catch((err: unknown) => {
      params.log.warn(
        `post-ready gateway data prewarm failed for ${currentItemName}: ${String(err)}`,
      );
      scheduleNext();
    });
  };

  // One cache fill per event-loop turn lets immediate client work run between steps.
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      idleTask?.stop();
      idleTask = undefined;
    },
  };
}
