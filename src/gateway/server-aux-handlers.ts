// Gateway auxiliary method handlers.
// Wires reload, secrets, exec approval, and plugin approval RPC handlers.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
import {
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { resolveApprovalSessionAudience } from "./approval-session-audience.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { createExecApprovalIosPushDelivery } from "./exec-approval-ios-push.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./server-methods/types.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";
export { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

type ReloadSecretsResult = {
  warningCount: number;
};

async function activateSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
): Promise<void> {
  const runtime = await import("../secrets/runtime.js");
  runtime.activateSecretsRuntimeSnapshot(snapshot);
}

function createLazyHandler(
  method: string,
  loadHandlers: () => Promise<GatewayRequestHandlers>,
): GatewayRequestHandler {
  return async (opts) => {
    const handlers = await loadHandlers();
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`lazy gateway handler not found: ${method}`);
    }
    await handler(opts);
  };
}

/** Create auxiliary gateway handlers that are not part of the core descriptor set. */
export function createGatewayAuxHandlers(params: {
  log: GatewayAuxHandlerLogger;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  buildReloadPlan?: (changedPaths: string[]) => GatewayReloadPlan;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  getChannelAutostartSuppression?: () => ChannelAutostartSuppression | null;
  logChannels: { info: (msg: string) => void };
}) {
  // Both approval kinds share one durable first-answer-wins registry and
  // Gateway-lifetime epoch while retaining separate in-process waiter maps.
  // A newly constructed Gateway cannot resume the prior lifetime's waiters.
  const approvalPersistence = { runtimeEpoch: randomUUID() };
  const approvalStartupNowMs = Date.now();
  closeOrphanedOperatorApprovals({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
    nowMs: approvalStartupNowMs,
  });
  pruneTerminalOperatorApprovals({ nowMs: approvalStartupNowMs });

  const execApprovalManager = new ExecApprovalManager<ExecApprovalRequestPayload>({
    approvalKind: "exec",
    persistence: approvalPersistence,
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    resolveAudienceSessionKeys: resolveApprovalSessionAudience,
    onError: (error, context) => {
      params.log.error?.(
        `${context.approvalKind} approval ${context.operation} failed for ${context.approvalId}: ${String(error)}`,
      );
    },
  });
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const loadExecApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/exec-approval.js").then(({ createExecApprovalHandlers }) =>
        createExecApprovalHandlers(execApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
  const pluginApprovalManager = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence: approvalPersistence,
    resolveAllowedDecisions: (request) => resolvePluginApprovalRequestAllowedDecisions(request),
    resolveAudienceSessionKeys: resolveApprovalSessionAudience,
    onError: (error, context) => {
      params.log.error?.(
        `${context.approvalKind} approval ${context.operation} failed for ${context.approvalId}: ${String(error)}`,
      );
    },
  });
  const loadPluginApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/plugin-approval.js").then(({ createPluginApprovalHandlers }) =>
        createPluginApprovalHandlers(pluginApprovalManager, {
          forwarder: execApprovalForwarder,
        }),
      ),
    { cacheRejections: true },
  );
  const loadApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/approval.js").then(({ createApprovalHandlers }) =>
        createApprovalHandlers({
          execApprovalManager,
          pluginApprovalManager,
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
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
  const loadSecretsHandlers = createLazyPromise(
    () =>
      import("./server-methods/secrets.js").then(({ createSecretsHandlers }) =>
        createSecretsHandlers({
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
              let nextSharedGatewaySessionGeneration;
              let sharedGatewaySessionGenerationChanged = false;
              const stoppedChannels: ChannelKind[] = [];
              const restartedChannels = new Set<ChannelKind>();
              try {
                const prepared = await params.activateRuntimeSecrets(
                  previousSnapshot.sourceConfig,
                  {
                    reason: "reload",
                    activate: true,
                  },
                );
                nextSharedGatewaySessionGeneration =
                  params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
                const plan = buildReloadPlan(
                  diffConfigPaths(previousSnapshot.config, prepared.config),
                );
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
                  if (params.getChannelAutostartSuppression?.()) {
                    throw new Error(
                      `secrets.reload requires restarting channels but channel autostart is suppressed by crash-loop breaker: ${restartChannels.join(", ")}`,
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
                await activateSecretsRuntimeSnapshot(previousSnapshot);
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
                  params.logChannels.info(
                    `rolling back ${channel} channel after secrets reload failure`,
                  );
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
          resolveSecrets: async ({
            allowedPaths,
            commandName,
            forcedActivePaths,
            optionalActivePaths,
            providerOverrides,
            targetIds,
          }) => {
            const { assignments, diagnostics, inactiveRefPaths } =
              await resolveCommandSecretsFromActiveRuntimeSnapshot({
                commandName,
                targetIds: new Set(targetIds),
                ...(allowedPaths ? { allowedPaths: new Set(allowedPaths) } : {}),
                ...(forcedActivePaths ? { forcedActivePaths: new Set(forcedActivePaths) } : {}),
                ...(optionalActivePaths
                  ? { optionalActivePaths: new Set(optionalActivePaths) }
                  : {}),
                ...(providerOverrides ? { providerOverrides } : {}),
              });
            if (assignments.length === 0) {
              return {
                assignments: [] as CommandSecretAssignment[],
                diagnostics,
                inactiveRefPaths,
              };
            }
            return { assignments, diagnostics, inactiveRefPaths };
          },
        }),
      ),
    { cacheRejections: true },
  );

  return {
    execApprovalManager,
    forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested,
    pluginApprovalManager,
    extraHandlers: {
      "exec.approval.get": createLazyHandler("exec.approval.get", loadExecApprovalHandlers),
      "exec.approval.list": createLazyHandler("exec.approval.list", loadExecApprovalHandlers),
      "exec.approval.request": createLazyHandler("exec.approval.request", loadExecApprovalHandlers),
      "exec.approval.waitDecision": createLazyHandler(
        "exec.approval.waitDecision",
        loadExecApprovalHandlers,
      ),
      "exec.approval.resolve": createLazyHandler("exec.approval.resolve", loadExecApprovalHandlers),
      "plugin.approval.list": createLazyHandler("plugin.approval.list", loadPluginApprovalHandlers),
      "plugin.approval.request": createLazyHandler(
        "plugin.approval.request",
        loadPluginApprovalHandlers,
      ),
      "plugin.approval.waitDecision": createLazyHandler(
        "plugin.approval.waitDecision",
        loadPluginApprovalHandlers,
      ),
      "plugin.approval.resolve": createLazyHandler(
        "plugin.approval.resolve",
        loadPluginApprovalHandlers,
      ),
      "approval.get": createLazyHandler("approval.get", loadApprovalHandlers),
      "approval.resolve": createLazyHandler("approval.resolve", loadApprovalHandlers),
      "secrets.reload": createLazyHandler("secrets.reload", loadSecretsHandlers),
      "secrets.resolve": createLazyHandler("secrets.resolve", loadSecretsHandlers),
    },
  };
}
