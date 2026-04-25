import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { type PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload.js";
import { createExecApprovalIosPushDelivery } from "./exec-approval-ios-push.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

type ReloadSecretsResult = {
  warningCount: number;
};

export function createGatewayAuxHandlers(params: {
  log: GatewayAuxHandlerLogger;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  buildReloadPlan?: (changedPaths: string[]) => GatewayReloadPlan;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  logChannels: { info: (msg: string) => void };
}) {
  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
    iosPushDelivery: execApprovalIosPushDelivery,
  });
  const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
  const pluginApprovalManager = new ExecApprovalManager<PluginApprovalRequestPayload>();
  const pluginApprovalHandlers = createPluginApprovalHandlers(pluginApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  // Serialize the entire `secrets.reload` path (activation + channel restart)
  // so concurrent callers cannot overlap the stop/start loop and so the
  // "before" snapshot used for the reload-plan diff is always the snapshot
  // replaced by this call's activation, not one captured by a prior caller.
  let reloadInFlight: Promise<ReloadSecretsResult> | null = null;
  const runExclusiveReload = (
    fn: () => Promise<ReloadSecretsResult>,
  ): Promise<ReloadSecretsResult> => {
    if (reloadInFlight) {
      return reloadInFlight;
    }
    const run = (async () => {
      try {
        return await fn();
      } finally {
        reloadInFlight = null;
      }
    })();
    reloadInFlight = run;
    return run;
  };
  const secretsHandlers = createSecretsHandlers({
    reloadSecrets: () =>
      runExclusiveReload(async () => {
        const previousSnapshot = getActiveSecretsRuntimeSnapshot();
        if (!previousSnapshot) {
          throw new Error("Secrets runtime snapshot is not active.");
        }
        // Snapshot both `current` and `required` because
        // `setCurrentSharedGatewaySessionGeneration` can clear `required` as
        // a side effect of activating a new generation. Restoring only
        // `current` on rollback would leave `required` cleared and weaken
        // shared-gateway auth-generation enforcement after a failed reload.
        const previousSharedGatewaySessionGeneration =
          params.sharedGatewaySessionGenerationState.current;
        const previousSharedGatewaySessionGenerationRequired =
          params.sharedGatewaySessionGenerationState.required;
        let nextSharedGatewaySessionGeneration = previousSharedGatewaySessionGeneration;
        let sharedGatewaySessionGenerationChanged = false;
        const stoppedChannels: ChannelKind[] = [];
        const restartedChannels = new Set<ChannelKind>();
        try {
          const prepared = await params.activateRuntimeSecrets(previousSnapshot.sourceConfig, {
            reason: "reload",
            activate: true,
          });
          nextSharedGatewaySessionGeneration =
            params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
          const plan = buildReloadPlan(diffConfigPaths(previousSnapshot.config, prepared.config));
          setCurrentSharedGatewaySessionGeneration(
            params.sharedGatewaySessionGenerationState,
            nextSharedGatewaySessionGeneration,
          );
          sharedGatewaySessionGenerationChanged =
            previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
          if (sharedGatewaySessionGenerationChanged) {
            disconnectStaleSharedGatewayAuthClients({
              clients: params.clients,
              expectedGeneration: nextSharedGatewaySessionGeneration,
            });
          }
          if (plan.restartChannels.size > 0) {
            const restartChannels = [...plan.restartChannels];
            if (
              isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
              isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
            ) {
              throw new Error(
                `secrets.reload requires restarting channels: ${restartChannels.join(", ")}`,
              );
            }
            const restartFailures: ChannelKind[] = [];
            for (const channel of restartChannels) {
              params.logChannels.info(`restarting ${channel} channel after secrets reload`);
              // Track for rollback before awaiting stopChannel: if stopChannel
              // throws after partially stopping the channel (for example, a
              // plugin hook rejects after the runtime already closed the
              // socket), we still need the outer catch to attempt restart so
              // the channel is not left down after a failed reload.
              stoppedChannels.push(channel);
              try {
                await params.stopChannel(channel);
                await params.startChannel(channel);
                restartedChannels.add(channel);
              } catch {
                params.logChannels.info(
                  `failed to restart ${channel} channel after secrets reload`,
                );
                restartFailures.push(channel);
              }
            }
            if (restartFailures.length > 0) {
              throw new Error(
                `failed to restart channels after secrets reload: ${restartFailures.join(", ")}`,
              );
            }
          }
          return { warningCount: prepared.warnings.length };
        } catch (err) {
          activateSecretsRuntimeSnapshot(previousSnapshot);
          params.sharedGatewaySessionGenerationState.current =
            previousSharedGatewaySessionGeneration;
          params.sharedGatewaySessionGenerationState.required =
            previousSharedGatewaySessionGenerationRequired;
          if (sharedGatewaySessionGenerationChanged) {
            disconnectStaleSharedGatewayAuthClients({
              clients: params.clients,
              expectedGeneration: previousSharedGatewaySessionGeneration,
            });
          }
          for (const channel of stoppedChannels) {
            params.logChannels.info(`rolling back ${channel} channel after secrets reload failure`);
            try {
              if (restartedChannels.has(channel)) {
                await params.stopChannel(channel);
              }
              await params.startChannel(channel);
            } catch {
              params.logChannels.info(
                `failed to roll back ${channel} channel after secrets reload`,
              );
            }
          }
          throw err;
        }
      }),
    log: params.log,
    resolveSecrets: async ({ commandName, targetIds }) => {
      const { assignments, diagnostics, inactiveRefPaths } =
        resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName,
          targetIds: new Set(targetIds),
        });
      if (assignments.length === 0) {
        return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
      }
      return { assignments, diagnostics, inactiveRefPaths };
    },
  });

  return {
    execApprovalManager,
    pluginApprovalManager,
    extraHandlers: {
      ...execApprovalHandlers,
      ...pluginApprovalHandlers,
      ...secretsHandlers,
    },
  };
}
