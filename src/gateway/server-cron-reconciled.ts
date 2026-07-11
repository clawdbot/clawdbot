// Gateway cron reconciliation lifecycle.
// Suppresses stale scheduler completions across reload and shutdown boundaries.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookCronReconciledContext,
  PluginHookCronReconciledEvent,
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
  runHook: (
    event: PluginHookCronReconciledEvent,
    ctx: PluginHookCronReconciledContext,
  ) => Promise<void>;
}): GatewayCronReconciliation {
  let lifecycleGeneration = 0;
  let activeAbortController: AbortController | undefined;

  const supersedeActive = () => {
    lifecycleGeneration += 1;
    activeAbortController?.abort();
    activeAbortController = undefined;
  };

  return {
    arm: ({ reason, config, cronState }) => {
      supersedeActive();
      const generation = lifecycleGeneration;
      const abortController = new AbortController();
      activeAbortController = abortController;
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
          // Each signal owns one exact scheduler snapshot. Do not serialize
          // generations: a stuck stale observer must not hide the current state.
          if (
            params.isClosing() ||
            generation !== lifecycleGeneration ||
            abortController.signal.aborted
          ) {
            return;
          }
          await params.runHook(event, {
            port: params.port,
            config,
            workspaceDir: params.workspaceDir,
            getCron: () => cron,
            abortSignal: abortController.signal,
          });
        },
      };
    },
    invalidate: supersedeActive,
  };
}
