// Gateway auxiliary method handlers.
// Wires reload, secrets, exec approval, and plugin approval RPC handlers.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import {
  type ExecApprovalDecision,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  type SystemAgentApprovalRequestPayload,
} from "../infra/system-agent-approvals.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
import {
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { resolveApprovalSessionAudienceWithFallback } from "./approval-session-audience.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import {
  createExecApprovalIosPushDelivery,
  createPluginApprovalIosPushDelivery,
} from "./exec-approval-ios-push.js";
import {
  ExecApprovalManager,
  type OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import { createLazyHandler } from "./lazy-handler.js";
import {
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.js";
import { QuestionManager } from "./question-manager.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import { cancelRunBoundExecApprovals } from "./server-methods/approval-run-cancellation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureSharedGatewaySessionGenerationOwnership,
  claimSharedGatewaySessionGenerationIfOwned,
  disconnectStaleSharedGatewayAuthClients,
  finalizeOwnedSharedGatewaySessionGeneration,
  isSharedGatewaySessionGenerationOwnershipCurrent,
  replaceOwnedSharedGatewaySessionGenerationState,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationOwnership,
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

async function activateSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  options?: {
    canActivate?: () => boolean;
    onActivated?: () => void;
  },
): Promise<number | null> {
  const runtime = await import("../secrets/runtime.js");
  if (options?.canActivate && !options.canActivate()) {
    return null;
  }
  if (!runtime.activateSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision)) {
    return null;
  }
  options?.onActivated?.();
  return runtime.getActiveSecretsRuntimeSnapshotRevision();
}

async function restoreSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  options?: { onActivated?: () => void },
): Promise<number | null> {
  const runtime = await import("../secrets/runtime.js");
  if (!runtime.restoreSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision, ownedSnapshot)) {
    return null;
  }
  options?.onActivated?.();
  return runtime.getActiveSecretsRuntimeSnapshotRevision();
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
  onApprovalLifecycle?: (event: OperatorApprovalLifecycleEvent) => void;
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
  const createApprovalManager = <TPayload>(
    approvalKind: "exec" | "plugin" | "system-agent",
    resolveAllowedDecisions: (request: TPayload) => readonly ExecApprovalDecision[],
  ) =>
    new ExecApprovalManager<TPayload>({
      approvalKind,
      persistence: approvalPersistence,
      resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
      resolveAllowedDecisions,
      onLifecycle: params.onApprovalLifecycle,
      onError: (error, context) =>
        params.log.error?.(
          `${context.approvalKind} approval ${context.operation} failed for ${context.approvalId}: ${String(error)}`,
        ),
    });
  const execApprovalManager = createApprovalManager<ExecApprovalRequestPayload>(
    "exec",
    resolveExecApprovalRequestAllowedDecisions,
  );
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const cancelRunBoundApprovals = (runId: string, context: GatewayRequestContext): number =>
    cancelRunBoundExecApprovals({
      runId,
      manager: execApprovalManager,
      context,
      forwarder: execApprovalForwarder,
      iosPushDelivery: execApprovalIosPushDelivery,
    });
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
  const questionManager = new QuestionManager();
  const loadQuestionHandlers = createLazyPromise(
    () =>
      import("./server-methods/question.js").then(({ createQuestionHandlers }) =>
        createQuestionHandlers(questionManager),
      ),
    { cacheRejections: true },
  );
  const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
  const pluginApprovalManager = createApprovalManager<PluginApprovalRequestPayload>(
    "plugin",
    resolveCanonicalPluginApprovalRequestAllowedDecisions,
  );
  const pluginApprovalIosPushDelivery = createPluginApprovalIosPushDelivery({ log: params.log });
  const systemAgentApprovalManager = createApprovalManager<SystemAgentApprovalRequestPayload>(
    "system-agent",
    () => SYSTEM_AGENT_APPROVAL_DECISIONS,
  );
  const loadPluginApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/plugin-approval.js").then(({ createPluginApprovalHandlers }) =>
        createPluginApprovalHandlers(pluginApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: pluginApprovalIosPushDelivery,
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
          systemAgentApprovalManager,
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
          pluginIosPushDelivery: pluginApprovalIosPushDelivery,
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
              let transaction:
                | {
                    previousSnapshot: PreparedSecretsRuntimeSnapshot;
                    previousSharedGatewaySessionGeneration: string | undefined;
                    previousSharedGatewaySessionGenerationRequired: string | undefined | null;
                    prepared: PreparedSecretsRuntimeSnapshot;
                    plan: GatewayReloadPlan;
                    nextSharedGatewaySessionGeneration: string | undefined;
                    sharedGatewaySessionGenerationChanged: boolean;
                    generationOwnership: SharedGatewaySessionGenerationOwnership;
                    publishedSnapshotRevision: number;
                  }
                | undefined;
              const stoppedChannels: ChannelKind[] = [];
              const restartedChannels = new Set<ChannelKind>();
              try {
                for (;;) {
                  const previousSnapshot = getActiveSecretsRuntimeSnapshot();
                  if (!previousSnapshot) {
                    throw new Error("Secrets runtime snapshot is not active.");
                  }
                  const previousSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
                  const previousGenerationOwnership =
                    captureSharedGatewaySessionGenerationOwnership(
                      params.sharedGatewaySessionGenerationState,
                    );
                  // Snapshot both generation fields with the candidate revision.
                  // A stale preparation retries all three owners together.
                  const previousSharedGatewaySessionGeneration =
                    previousGenerationOwnership.generation;
                  const previousSharedGatewaySessionGenerationRequired =
                    params.sharedGatewaySessionGenerationState.required;
                  const prepared = await params.activateRuntimeSecrets(
                    previousSnapshot.sourceConfig,
                    {
                      reason: "reload",
                      activate: false,
                      publishFailureAsDegraded: true,
                      canPublishFailureAsDegraded: () =>
                        getActiveSecretsRuntimeSnapshotRevision() === previousSnapshotRevision,
                    },
                  );
                  const plan = buildReloadPlan(
                    diffConfigPaths(previousSnapshot.config, prepared.config),
                  );
                  const nextSharedGatewaySessionGeneration =
                    params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
                  let publishedSnapshotRevision: number | null = null;
                  let generationOwnership: SharedGatewaySessionGenerationOwnership | null = null;
                  const activateIfCurrent =
                    params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
                  if (activateIfCurrent) {
                    const activated = await activateIfCurrent(
                      prepared,
                      previousSnapshotRevision,
                      {
                        reason: "reload",
                        activate: true,
                      },
                      async () => {
                        publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
                        generationOwnership = claimSharedGatewaySessionGenerationIfOwned(
                          params.sharedGatewaySessionGenerationState,
                          previousGenerationOwnership,
                          nextSharedGatewaySessionGeneration,
                        );
                      },
                      () =>
                        isSharedGatewaySessionGenerationOwnershipCurrent(
                          params.sharedGatewaySessionGenerationState,
                          previousGenerationOwnership,
                        ),
                    );
                    if (!activated) {
                      continue;
                    }
                  } else {
                    publishedSnapshotRevision = await activateSecretsRuntimeSnapshotIfCurrent(
                      prepared,
                      previousSnapshotRevision,
                      {
                        canActivate: () =>
                          isSharedGatewaySessionGenerationOwnershipCurrent(
                            params.sharedGatewaySessionGenerationState,
                            previousGenerationOwnership,
                          ),
                        onActivated: () => {
                          generationOwnership = claimSharedGatewaySessionGenerationIfOwned(
                            params.sharedGatewaySessionGenerationState,
                            previousGenerationOwnership,
                            nextSharedGatewaySessionGeneration,
                          );
                        },
                      },
                    );
                    if (publishedSnapshotRevision === null) {
                      continue;
                    }
                  }
                  if (publishedSnapshotRevision === null || generationOwnership === null) {
                    throw new Error("Secrets runtime activation did not publish ownership.");
                  }
                  transaction = {
                    previousSnapshot,
                    previousSharedGatewaySessionGeneration,
                    previousSharedGatewaySessionGenerationRequired,
                    prepared,
                    plan,
                    nextSharedGatewaySessionGeneration,
                    sharedGatewaySessionGenerationChanged:
                      previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration,
                    generationOwnership,
                    publishedSnapshotRevision,
                  };
                  if (
                    !isSharedGatewaySessionGenerationOwnershipCurrent(
                      params.sharedGatewaySessionGenerationState,
                      generationOwnership,
                    )
                  ) {
                    throw new Error("secrets.reload was superseded by a newer config write");
                  }
                  break;
                }
                const {
                  prepared,
                  plan,
                  generationOwnership,
                  nextSharedGatewaySessionGeneration,
                  sharedGatewaySessionGenerationChanged,
                } = transaction;
                if (sharedGatewaySessionGenerationChanged) {
                  disconnectStaleSharedGatewayAuthClients({
                    clients: params.clients,
                    expectedGeneration: nextSharedGatewaySessionGeneration,
                  });
                }
                // Account-scoped changes restart their whole channel here:
                // secrets.reload has no per-account restart path, and a missed
                // restart would leave rotated credentials unapplied.
                const channelsToRestart = new Set<ChannelKind>([
                  ...plan.restartChannels,
                  ...(plan.restartChannelAccounts?.keys() ?? []),
                ]);
                if (channelsToRestart.size > 0) {
                  const restartChannels = [...channelsToRestart];
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
                    if (
                      !isSharedGatewaySessionGenerationOwnershipCurrent(
                        params.sharedGatewaySessionGenerationState,
                        generationOwnership,
                      )
                    ) {
                      throw new Error("secrets.reload was superseded by a newer config write");
                    }
                    params.logChannels.info(`restarting ${channel} channel after secrets reload`);
                    // Track for rollback before awaiting stopChannel: if stopChannel
                    // throws after partially stopping the channel, still attempt recovery.
                    stoppedChannels.push(channel);
                    try {
                      await params.stopChannel(channel);
                      if (
                        !isSharedGatewaySessionGenerationOwnershipCurrent(
                          params.sharedGatewaySessionGenerationState,
                          generationOwnership,
                        )
                      ) {
                        throw new Error("secrets.reload was superseded by a newer config write");
                      }
                      await params.startChannel(channel);
                      restartedChannels.add(channel);
                      if (
                        !isSharedGatewaySessionGenerationOwnershipCurrent(
                          params.sharedGatewaySessionGenerationState,
                          generationOwnership,
                        )
                      ) {
                        throw new Error("secrets.reload was superseded by a newer config write");
                      }
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
                if (
                  !finalizeOwnedSharedGatewaySessionGeneration(
                    params.sharedGatewaySessionGenerationState,
                    generationOwnership,
                  )
                ) {
                  throw new Error("secrets.reload was superseded by a newer config write");
                }
                return { warningCount: prepared.warnings.length };
              } catch (err) {
                let generationRestored = false;
                if (transaction) {
                  const failedTransaction = transaction;
                  await restoreSecretsRuntimeSnapshotIfCurrent(
                    failedTransaction.previousSnapshot,
                    failedTransaction.publishedSnapshotRevision,
                    failedTransaction.prepared,
                    {
                      onActivated: () => {
                        generationRestored = replaceOwnedSharedGatewaySessionGenerationState(
                          params.sharedGatewaySessionGenerationState,
                          failedTransaction.generationOwnership,
                          {
                            current: failedTransaction.previousSharedGatewaySessionGeneration,
                            required:
                              failedTransaction.previousSharedGatewaySessionGenerationRequired,
                          },
                        );
                      },
                    },
                  );
                }
                if (generationRestored && transaction) {
                  if (transaction.sharedGatewaySessionGenerationChanged) {
                    disconnectStaleSharedGatewayAuthClients({
                      clients: params.clients,
                      expectedGeneration: transaction.previousSharedGatewaySessionGeneration,
                    });
                  }
                }
                // Generation ownership fences state rollback, not liveness.
                // Restart stopped channels against whichever runtime is current now.
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
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    questionManager,
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
      "approval.history": createLazyHandler("approval.history", loadApprovalHandlers),
      "approval.resolve": createLazyHandler("approval.resolve", loadApprovalHandlers),
      "question.request": createLazyHandler("question.request", loadQuestionHandlers),
      "question.waitAnswer": createLazyHandler("question.waitAnswer", loadQuestionHandlers),
      "question.resolve": createLazyHandler("question.resolve", loadQuestionHandlers),
      "question.get": createLazyHandler("question.get", loadQuestionHandlers),
      "question.list": createLazyHandler("question.list", loadQuestionHandlers),
      "secrets.reload": createLazyHandler("secrets.reload", loadSecretsHandlers),
      "secrets.resolve": createLazyHandler("secrets.resolve", loadSecretsHandlers),
    },
  };
}
