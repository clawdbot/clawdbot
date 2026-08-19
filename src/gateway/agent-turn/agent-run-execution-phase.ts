import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { attachAgentCommandAdmissionFacts } from "../../agents/agent-command-admission-facts.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { prepareGitCoauthorAttribution } from "../../agents/git-coauthor-attribution.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { loadPublishedGatewayReplyDispatchRuntime } from "../../agents/prepared-model-runtime.js";
import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import {
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { createAgentRunModelSelectionHandler } from "../server-methods/agent-run-model-selection.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { formatForLog } from "../ws-log.js";
import { setAbortedAgentDedupeEntries, setGatewayDedupeEntries } from "./agent-dedupe.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import {
  yieldAfterAgentAcceptedAck,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import {
  resolveAgentRestartRecoveryChannelContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";
import type { PreparedAgentRunDispatch } from "./agent-run-admission-phase.js";
import { withAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import {
  resolveAbortedAgentStopReason,
  dispatchAgentRunFromGateway,
} from "./agent-run-dispatch.js";
import { resolveExecutionIdentitySpawnFacts } from "./agent-run-execution-lineage.js";
import {
  finalizePreparedAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export function startAgentRunExecution(params: {
  prepared: PreparedAgentRunDispatch;
  mainRestartRecoveryOwnerLease?: MainSessionRecoveryOwnerLease;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  storePath?: string;
  agentId?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  isNewSession: boolean;
  isRawModelRun: boolean;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  suppressVisibleSessionEffects: boolean;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder: PromptImageOrderEntry[];
  media: MediaFact[];
  inputProvenance?: InputProvenance;
  runId: string;
  agentDedupeKeys: readonly string[];
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  bestEffortDeliver: boolean;
  lifecycleGeneration: string;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  preserveUserFacingSessionModelState: boolean;
  sessionEffects?: "visible" | "internal";
  skipAgentInitialSessionTouch: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
  canUseInternalRuntimeHandoff: boolean;
  client: AgentTurnPrincipal | null;
  context: AgentTurnContext;
  io: AgentTurnIo;
  releaseCronContinuationClaimWithRecovery: (
    outcome?: { terminalOutcome: AgentRunTerminalOutcome },
    onRecovered?: () => void,
  ) => Promise<boolean>;
}): void {
  const { prepared } = params;
  let unpersistedOffloadedRefs = prepared.unpersistedOffloadedRefs;
  let releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
  const cleanupAdmittedRun: typeof prepared.activeRunAbort.cleanup = (options) => {
    const refsToDiscard = unpersistedOffloadedRefs;
    unpersistedOffloadedRefs = [];
    prepared.activeRunAbort.cleanup(options);
    prepared.activeGatewayWorkAdmission.release();
    releaseGatewayRootContinuation?.();
    releaseGatewayRootContinuation = undefined;
    void discardPreparedInboundMedia(refsToDiscard, params.context.logGateway);
  };
  void prepared.activeGatewayWorkAdmission.run(async () => {
    await yieldAfterAgentAcceptedAck();
    let dispatched = false;
    let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
    try {
      if (prepared.activeRunAbort.controller.signal.aborted) {
        pendingRecovery = await prepared.restoreAdmittedRestartRecoveryInterrupted?.();
        const stopReason = resolveAbortedAgentStopReason(prepared.activeRunAbort.entry);
        setAbortedAgentDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
          agentId: params.activeSessionAgentId,
          runId: params.runId,
          stopReason,
        });
        params.io.emitFinal(
          [
            true,
            {
              runId: params.runId,
              status: "timeout" as const,
              summary: "aborted",
              stopReason,
              timeoutPhase: "queue" as const,
              providerStarted: false,
            },
            undefined,
          ],
          { runId: params.runId },
        );
        return;
      }

      let message = prepared.userTurn.message;
      let execApprovalContinuationPromptRange =
        prepared.userTurn.execApprovalContinuationPromptRange;
      const execApprovalContinuationTranscriptPromptRange =
        prepared.userTurn.execApprovalContinuationTranscriptPromptRange;

      if (!params.isOneShotModelRun && params.resolvedSessionKey) {
        await reactivateCompletedSubagentSession({
          sessionKey: params.resolvedSessionKey,
          runId: params.runId,
          task: message,
        });
      }
      if (
        !params.suppressVisibleSessionEffects &&
        params.requestedSessionKey &&
        params.resolvedSessionKey &&
        params.isNewSession
      ) {
        emitSessionsChanged(params.context, {
          sessionKey: params.resolvedSessionKey,
          agentId: params.activeSessionAgentId,
          reason: "create",
        });
      }
      if (!params.suppressVisibleSessionEffects && params.resolvedSessionKey) {
        emitSessionsChanged(params.context, {
          sessionKey: params.resolvedSessionKey,
          agentId: params.activeSessionAgentId,
          reason: "send",
        });
      }

      if (!params.isRawModelRun) {
        const unannotatedMessage = message;
        message = annotateInterSessionPromptText(unannotatedMessage, params.inputProvenance);
        if (execApprovalContinuationPromptRange) {
          if (!message.endsWith(unannotatedMessage)) {
            throw new Error("exec approval continuation prompt range could not be annotated");
          }
          const offset = message.length - unannotatedMessage.length;
          execApprovalContinuationPromptRange = {
            start: offset + execApprovalContinuationPromptRange.start,
            end: offset + execApprovalContinuationPromptRange.end,
          };
        }
      }
      const senderIsOwner = prepared.userTurn.senderIsOwner;
      const userTurnTranscriptRecorder = prepared.userTurn.recorder;

      const ingressAgentId = params.resolvedSessionKey
        ? params.activeSessionAgentId
        : params.agentId;
      const replyDispatchRuntime = await loadPublishedGatewayReplyDispatchRuntime({
        agentId: params.activeSessionAgentId,
      });
      if (!replyDispatchRuntime?.pluginGeneration) {
        throw new Error(
          `prepared reply dispatch runtime was not published for ${params.activeSessionAgentId}`,
        );
      }
      // Plugin-owned additive grants stay internal to the authenticated in-process run.
      // Public agent params cannot supply them, and normal tool policy still filters them.
      const runtimePluginToolGrant =
        params.client?.internal?.agentRunTracking === "plugin_subagent" &&
        params.client.internal.pluginRuntimeOwnerId ===
          params.client.internal.runtimePluginToolGrant?.pluginId
          ? params.client.internal.runtimePluginToolGrant
          : undefined;
      const executionIdentityAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
        isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
        retryOnly: params.request.internalExecutionIdentityRetry,
        runId: params.runId,
        sessionEntry: params.sessionEntry,
      });
      const agentRuntimeIdentity = params.client?.internal?.agentRuntimeIdentity;
      const executionIdentitySpawnFacts =
        agentRuntimeIdentity &&
        params.context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) === true
          ? resolveExecutionIdentitySpawnFacts(agentRuntimeIdentity)
          : undefined;
      const restartRecoveryChannelContext = resolveAgentRestartRecoveryChannelContext({
        canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
        expectedExistingSessionId: params.request.expectedExistingSessionId,
        resolvedSessionId: params.resolvedSessionId,
        runId: params.runId,
        sessionEntry: params.sessionEntry,
      });
      const runContext = {
        messageChannel:
          restartRecoveryChannelContext?.channel ?? params.delivery.originMessageChannel,
        accountId:
          restartRecoveryChannelContext?.requesterAccountId ?? params.delivery.resolvedAccountId,
        senderId: restartRecoveryChannelContext?.requesterSenderId,
        groupId: params.groupId,
        groupChannel: params.groupChannel,
        groupSpace: params.groupSpace,
        currentChannelId: restartRecoveryChannelContext?.currentChannelId,
        currentThreadTs:
          restartRecoveryChannelContext?.currentThreadTs ??
          (prepared.resolvedThreadId != null ? String(prepared.resolvedThreadId) : undefined),
      };
      setChannelSourceTurnId(runContext, restartRecoveryChannelContext?.sourceTurnId);
      setChannelSourceTurnSameThreadRequired(
        runContext,
        restartRecoveryChannelContext?.sameChannelThreadRequired,
      );

      const localUserIngress = getGatewayLocalUserIngress(params.client);
      if (localUserIngress) {
        attachAgentCommandAdmissionFacts(runContext, localUserIngress.facts);
      }
      finalizePreparedAgentRunUserTurn(prepared.userTurn);
      dispatchAgentRunFromGateway(
        withAgentRunDispatchExecutionIdentity(
          {
            commandRuntimeContext: {
              config: replyDispatchRuntime.config,
              pluginGeneration: replyDispatchRuntime.pluginGeneration,
            },
            cronCreatorAuthority: prepared.cronCreatorAuthority,
            ingressOpts: {
              message,
              images: params.images,
              imageOrder: params.imageOrder,
              media: params.media,
              agentId: ingressAgentId,
              provider: prepared.effectiveProviderOverride,
              model: prepared.effectiveModelOverride,
              to: params.delivery.resolvedTo,
              sessionId: params.resolvedSessionId,
              sessionKey: params.resolvedSessionKey,
              thinking: prepared.effectiveThinking,
              deliver: params.delivery.deliver,
              deliveryTargetMode: params.delivery.deliveryTargetMode,
              channel: params.delivery.resolvedChannel,
              accountId: params.delivery.resolvedAccountId,
              threadId: prepared.resolvedThreadId,
              runContext,
              ...(prepared.userTurn.bashElevated
                ? { bashElevated: prepared.userTurn.bashElevated }
                : {}),
              ...(execApprovalContinuationPromptRange
                ? { execApprovalContinuationPromptRange }
                : {}),
              ...(execApprovalContinuationTranscriptPromptRange
                ? { execApprovalContinuationTranscriptPromptRange }
                : {}),
              groupId: params.groupId,
              groupChannel: params.groupChannel,
              groupSpace: params.groupSpace,
              spawnedBy: params.spawnedBy,
              timeout: params.request.timeout?.toString(),
              bestEffortDeliver: params.bestEffortDeliver,
              messageChannel: params.delivery.originMessageChannel,
              runId: params.runId,
              lane: params.request.lane,
              modelRun: params.request.modelRun === true,
              promptMode: params.request.promptMode,
              extraSystemPrompt: params.request.extraSystemPrompt,
              gitCoauthorAttribution: prepareGitCoauthorAttribution({
                agentId: params.activeSessionAgentId,
                config: params.cfgForAgent ?? params.cfg,
                currentProfileId: params.client?.authenticatedUserProfile?.profileId,
                sessionKey: params.resolvedSessionKey,
                storePath: params.storePath,
              }),
              bootstrapContextMode: params.request.bootstrapContextMode,
              bootstrapContextRunKind: params.effectiveBootstrapContextRunKind,
              toolsAllow: params.restoredCronContinuation?.toolsAllow,
              runtimePluginToolGrant,
              trustedInternalHandoff: prepared.trustedInternalHandoff,
              toolsAllowIsDefault: params.restoredCronContinuation?.toolsAllowIsDefault,
              scheduledToolPolicy: params.restoredCronContinuation
                ? resolveScheduledToolPolicyContext({
                    toolsAllow: params.restoredCronContinuation.toolsAllow,
                    scheduledToolPolicy: params.restoredCronContinuation.scheduledToolPolicy,
                    callerOrigin: params.restoredCronContinuation.scheduledToolCallerOrigin,
                  })
                : undefined,
              requireExplicitMessageTarget:
                params.restoredCronContinuation?.cliSessionBindingFacts
                  ?.requireExplicitMessageTarget,
              cliSessionBindingFacts: params.restoredCronContinuation?.cliSessionBindingFacts,
              acpTurnSource: params.request.acpTurnSource,
              internalEvents: params.request.internalEvents,
              inputProvenance: params.inputProvenance,
              senderIsOwner,
              sessionEffects: params.sessionEffects,
              skipInitialSessionTouch: params.skipAgentInitialSessionTouch,
              preserveUserFacingSessionModelState:
                params.preserveUserFacingSessionModelState && !params.restoredCronContinuation,
              sourceReplyDeliveryMode: params.restoredCronContinuation
                ? params.restoredCronContinuation.cliSessionBindingFacts?.sourceReplyDeliveryMode
                : params.request.sourceReplyDeliveryMode,
              disableMessageTool: params.request.disableMessageTool,
              swarmCollector: params.request.swarmCollector,
              swarmOutputSchema: params.request.swarmOutputSchema,
              forceRestartSafeTools: params.request.forceRestartSafeTools,
              forceCodeModeTools: params.request.forceCodeModeTools,
              ...(executionIdentityAdmission ? { executionIdentityAdmission } : {}),
              operationalRunInstance: prepared.operationalRunInstance,
              onAdmittedRunContext: (admittedRunContext) => {
                bindGatewayContextResolver(
                  admittedRunContext,
                  params.context.resolveGatewayContext,
                );
                const authority = getAdmittedRunDelegatedAuthority(admittedRunContext);
                if (!authority) {
                  throw new Error("agent run delegated authority was not admitted");
                }
                // Sessionless runs intentionally have no abort-map owner. Their
                // prepared admission retains authority until agentCommand closes it.
                if (prepared.activeRunAbort.registered) {
                  prepared.activeRunAbort.bindAgentRunDelegatedAuthority(authority);
                }
              },
              internalDeliveryMediaUrls: params.client?.internal?.internalDeliveryMediaUrls,
              internalDeliverySuppressText: params.client?.internal?.internalDeliverySuppressText,
              suppressPromptPersistence: prepared.userTurn.suppressPromptPersistence,
              userTurnTranscriptRecorder,
              cleanupBundleMcpOnRunEnd: params.request.cleanupBundleMcpOnRunEnd,
              abortSignal: prepared.activeRunAbort.controller.signal,
              lifecycleGeneration: params.lifecycleGeneration,
              onExecutionStarted: () => {
                if (prepared.activeRunAbort.markExecutionStarted() && params.resolvedSessionKey) {
                  emitSessionsChanged(params.context, {
                    sessionKey: params.resolvedSessionKey,
                    agentId: params.agentId,
                    reason: "agent.run.started",
                  });
                }
              },
              onActiveModelSelected: createAgentRunModelSelectionHandler({
                context: params.context,
                runId: params.runId,
                cfg: params.cfg,
                cfgForAgent: params.cfgForAgent,
                restoredCronContinuationLifecycleRevision:
                  prepared.restoredCronContinuationLifecycleRevision,
                resolvedSessionKey: params.resolvedSessionKey,
                lifecycleStorePath: prepared.lifecycleStorePath,
                activeSessionAgentId: params.activeSessionAgentId,
                trustedInternalHandoff: prepared.trustedInternalHandoff,
              }),
              onSessionIdChanged: (sessionId) => {
                if (prepared.activeRunAbort.entry) {
                  prepared.activeRunAbort.entry.sessionId = sessionId;
                }
              },
              workspaceDir: resolveIngressWorkspaceOverrideForSessionRun({
                spawnedBy: params.spawnedBy,
                workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
                cwd: params.sessionEntry?.spawnedCwd,
              }),
              cwd: resolveSessionRuntimeCwd({
                requestedCwd: params.request.cwd,
                sessionEntry: params.sessionEntry,
              }),
              allowGatewaySubagentBinding: true,
              ...(params.mainRestartRecoveryOwnerLease
                ? { mainRestartRecoveryOwnerLease: params.mainRestartRecoveryOwnerLease }
                : {}),
              ...(params.isRestartRecoveryResumeRun ? { mainRestartRecoveryAdmitted: true } : {}),
              ...(params.request.internalExecutionIdentityRecoveryAttempt !== undefined
                ? {
                    mainRestartRecoveryAttempt:
                      params.request.internalExecutionIdentityRecoveryAttempt,
                  }
                : {}),
              allowModelOverride: prepared.effectiveAllowModelOverride,
            },
            runId: params.runId,
            dedupeKeys: params.agentDedupeKeys,
            abortController: prepared.activeRunAbort.controller,
            cleanupAbortController: cleanupAdmittedRun,
            onSettled: params.restoredCronContinuation
              ? async ({ terminalOutcome, onRecovered }) =>
                  await params.releaseCronContinuationClaimWithRecovery(
                    { terminalOutcome },
                    onRecovered,
                  )
              : undefined,
            io: params.io,
            context: params.context,
            taskTrackingMode: prepared.dispatchTaskTrackingMode,
            restoreAdmittedRecovery: prepared.restoreAdmittedRestartRecoveryInterrupted,
            canonicalSkillWorkspaceDir: params.sessionEntry?.worktree?.canonicalWorkspaceDir,
          },
          executionIdentitySpawnFacts,
        ),
      );
      dispatched = true;
    } catch (err) {
      const renderedErr = formatErrorMessageWithCode(err);
      const error = errorShape(ErrorCodes.UNAVAILABLE, renderedErr);
      const payload = {
        runId: params.runId,
        status: "error" as const,
        summary: renderedErr,
      };
      setGatewayDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        entry: { ts: Date.now(), ok: false, payload, error },
      });
      params.io.emitFinal([false, payload, error], {
        runId: params.runId,
        error: renderedErr,
      });
    } finally {
      if (!dispatched) {
        releasePreparedAgentRunUserTurn(prepared.userTurn);
        try {
          const restoreAdmittedRecovery = prepared.restoreAdmittedRestartRecoveryInterrupted;
          if (restoreAdmittedRecovery) {
            pendingRecovery ??= await repairMainSessionRecoveryMutation({
              mutation: restoreAdmittedRecovery,
              onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
              onError: (err) =>
                params.context.logGateway.warn(
                  `failed to restore undispatched restart recovery: ${formatForLog(err)}`,
                ),
            });
          }
        } finally {
          try {
            await params.releaseCronContinuationClaimWithRecovery();
          } finally {
            try {
              pendingRecovery ??= await releaseMainSessionRecoveryOwner(
                params.mainRestartRecoveryOwnerLease,
              );
            } catch (err) {
              params.context.logGateway.warn(
                `failed to release undispatched main restart recovery owner: ${formatForLog(err)}`,
              );
            } finally {
              try {
                cleanupAdmittedRun({ force: true });
              } finally {
                scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
              }
            }
          }
        }
      }
    }
  });
}
