// Gateway cron reconciliation lifecycle.
// Suppresses stale scheduler completions across reload and shutdown boundaries.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookCronReconciledEvent,
  PluginHookGatewayContext,
  PluginHookGatewayCronService,
} from "../plugins/hook-types.js";
import type { GatewayCronState } from "./server-cron.js";

type GatewayCronReconciliationArmParams = {
  reason: PluginHookCronReconciledEvent["reason"];
  config: OpenClawConfig;
  cronState: GatewayCronState;
};

export type GatewayCronReconciliation = {
  arm: (params: GatewayCronReconciliationArmParams) => {
    complete: () => Promise<void>;
  };
  invalidate: () => void;
};

export function createGatewayCronReconciliation(params: {
  port: number;
  workspaceDir: string;
  isClosing: () => boolean;
  runHook: (event: PluginHookCronReconciledEvent, ctx: PluginHookGatewayContext) => Promise<void>;
}): GatewayCronReconciliation {
  let lifecycleGeneration = 0;
  let dispatchTail = Promise.resolve();

  return {
    arm: ({ reason, config, cronState }) => {
      const generation = ++lifecycleGeneration;
      const cron = cronState.cron as PluginHookGatewayCronService;
      const event: PluginHookCronReconciledEvent = {
        reason,
        enabled: cronState.cronEnabled,
      };
      let completed = false;

      return {
        complete: async () => {
          if (completed) {
            return;
          }
          completed = true;
          const dispatch = dispatchTail.then(async () => {
            // A newer scheduler or shutdown owns reconciliation now. Dispatching
            // this completion would let plugins replace current state with stale data.
            if (params.isClosing() || generation !== lifecycleGeneration) {
              return;
            }
            await params.runHook(event, {
              port: params.port,
              config,
              workspaceDir: params.workspaceDir,
              getCron: () => cron,
            });
          });
          // Preserve lifecycle order even when one plugin callback is slow or fails.
          dispatchTail = dispatch.catch(() => {});
          await dispatch;
        },
      };
    },
    invalidate: () => {
      lifecycleGeneration += 1;
    },
  };
}
