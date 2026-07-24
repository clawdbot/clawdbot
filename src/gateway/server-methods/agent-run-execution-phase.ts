import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { consumeExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setAbortedAgentDedupeEntries, setGatewayDedupeEntries } from "./agent-dedupe.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import {
  clientHasAdminScope,
  shouldSuppressAgentPromptPersistence,
  yieldAfterAgentAcceptedAck,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { PreparedAgentRunDispatch } from "./agent-run-admission-phase.js";
import {
  deleteGatewayDedupeEntries,
  resolveAbortedAgentStopReason,
  dispatchAgentRunFromGateway,
} from "./agent-run-dispatch.js";
import { createAgentRunModelSelectionHandler } from "./agent-run-model-selection.js";
import { resolveSessionRuntimeCwd } from "./agent-session-reset.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function startAgentRunExecution(params: {
  prepared: PreparedAgentRunDispatch;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  resolvedSessionId?: string;
  agentId?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  isNewSession: boolean;
  isRawModelRun: boolean;
  isOneShotModelRun: boolean;
  suppressVisibleSessionEffects: boolean;
  message: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder: PromptImageOrderEntry[];
  effectiveTranscriptInputText: string;
  inputProvenance?: InputProvenance;
  runId: string;
  idempotencyKey: string;
  requestMessageId?: string;
  requestSenderId?: string;
  agentDedupeKeys: readonly string[];
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  bestEffortDeliver: boolean;
  lifecycleGeneration: string;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  requestedPromptPersistenceSuppression: boolean;
  preserveUserFacingSessionModelState: boolean;
  sessionEffects?: "visible" | "internal";
  skipAgentInitialSessionTouch: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  releaseCronContinuationClaimWithRecovery: (
    outcome?: { terminalOutcome: AgentRunTerminalOutcome },
    onRecovered?: () => void,
  ) => Promise<boolean>;
}): void {
  const { prepared } = params;
  let releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
  const cleanupAdmittedRun: typeof prepared.activeRunAbort.cleanup = (options) => {
    prepared.activeRunAbort.cleanup(options);
    prepared.activeGatewayWorkAdmission.release();
    releaseGatewayRootContinuation?.();
    releaseGatewayRootContinuation = undefined;
  };
  void prepared.activeGatewayWorkAdmission.run(async () => {
    let dispatched = false;
    const acceptedExecutionBarrier = params.client?.internal?.agentAcceptedExecutionBarrier;
    let acceptedExecutionBarrierPassed = !acceptedExecutionBarrier;
    let rejectedBarrierResponse:
      | {
          error: ReturnType<typeof errorShape>;
          payload: { runId: string; status: "error"; summary: string };
        }
      | undefined;
    try {
      await acceptedExecutionBarrier;
      acceptedExecutionBarrierPassed = true;
      await yieldAfterAgentAcceptedAck();
      if (prepared.activeRunAbort.controller.signal.aborted) {
        const stopReason = resolveAbortedAgentStopReason(prepared.activeRunAbort.entry);
        setAbortedAgentDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
          agentId: params.resolvedSessionKey === "global" ? params.activeSessionAgentId : undefined,
          runId: params.runId,
          stopReason,
        });
        params.respond(
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
          { runId: params.runId },
        );
        return;
      }

      if (!params.isOneShotModelRun && params.resolvedSessionKey) {
        await reactivateCompletedSubagentSession({
          sessionKey: params.resolvedSessionKey,
          runId: params.runId,
          task: params.message,
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
          ...(params.resolvedSessionKey === "global"
            ? { agentId: params.activeSessionAgentId }
            : {}),
          reason: "create",
        });
      }
      if (!params.suppressVisibleSessionEffects && params.resolvedSessionKey) {
        emitSessionsChanged(params.context, {
          sessionKey: params.resolvedSessionKey,
          ...(params.resolvedSessionKey === "global"
            ? { agentId: params.activeSessionAgentId }
            : {}),
          reason: "send",
        });
      }

      let message = params.message;
      if (!params.isRawModelRun) {
        message = annotateInterSessionPromptText(message, params.inputProvenance);
      }
      const userTurnTranscriptRecorder =
        params.resolvedSessionKey &&
        params.resolvedSessionId &&
        !params.suppressVisibleSessionEffects &&
        params.images.length === 0 &&
        params.imageOrder.length === 0
          ? createUserTurnTranscriptRecorder({
              input: {
                text: params.effectiveTranscriptInputText,
                timestamp: Date.now(),
                idempotencyKey: `${params.runId}:user`,
                ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
              },
              target: () => {
                const loaded = loadSessionEntry(params.resolvedSessionKey!, {
                  ...(params.activeSessionAgentId ? { agentId: params.activeSessionAgentId } : {}),
                  clone: false,
                });
                const loadedEntry = loaded.entry;
                const loadedSessionId = loadedEntry?.sessionId?.trim();
                if (loadedSessionId && loadedSessionId !== params.resolvedSessionId) {
                  return undefined;
                }
                const latestEntry = loadedSessionId
                  ? loadedEntry
                  : params.sessionEntry?.sessionId?.trim() === params.resolvedSessionId
                    ? params.sessionEntry
                    : {
                        sessionId: params.resolvedSessionId!,
                        updatedAt: Date.now(),
                        sessionFile: params.sessionEntry?.sessionFile,
                      };
                if (!latestEntry) {
                  return undefined;
                }
                return {
                  sessionId: latestEntry.sessionId,
                  sessionKey: params.resolvedSessionKey!,
                  sessionEntry: latestEntry,
                  sessionStore: loaded.store,
                  storePath: loaded.storePath,
                  agentId: params.activeSessionAgentId,
                  cwd: resolveSessionRuntimeCwd({ sessionEntry: latestEntry }),
                  ...(prepared.resolvedThreadId != null
                    ? { threadId: prepared.resolvedThreadId }
                    : {}),
                  config: params.cfgForAgent ?? params.cfg,
                };
              },
              errorContext: "gateway agent user turn transcript",
              beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
              onPersistenceError: (error) => {
                params.context.logGateway.warn(
                  `gateway agent user transcript persistence failed: ${formatForLog(error)}`,
                );
              },
            })
          : undefined;

      const ingressAgentId =
        params.resolvedSessionKey === "global"
          ? params.activeSessionAgentId
          : params.agentId &&
              (!params.resolvedSessionKey ||
                resolveAgentIdFromSessionKey(params.resolvedSessionKey) === params.agentId)
            ? params.agentId
            : undefined;
      let execApprovalFollowupRuntimeHandoff =
        params.canUseInternalRuntimeHandoff && params.execApprovalFollowupApprovalId
          ? consumeExecApprovalFollowupRuntimeHandoff({
              handoffId: params.request.internalRuntimeHandoffId,
              approvalId: params.execApprovalFollowupApprovalId,
              idempotencyKey: params.idempotencyKey,
              sessionKey: params.resolvedSessionKey,
            })
          : undefined;
      if (
        !execApprovalFollowupRuntimeHandoff &&
        params.canUseInternalRuntimeHandoff &&
        params.execApprovalFollowupApprovalId &&
        params.requestedSessionKeyRaw &&
        params.requestedSessionKeyRaw !== params.resolvedSessionKey
      ) {
        execApprovalFollowupRuntimeHandoff = consumeExecApprovalFollowupRuntimeHandoff({
          handoffId: params.request.internalRuntimeHandoffId,
          approvalId: params.execApprovalFollowupApprovalId,
          idempotencyKey: params.idempotencyKey,
          sessionKey: params.requestedSessionKeyRaw,
        });
      }
      // Plugin-owned additive grants stay internal to the authenticated in-process run.
      // Public agent params cannot supply them, and normal tool policy still filters them.
      const runtimePluginToolGrant =
        params.client?.internal?.agentRunTracking === "plugin_subagent" &&
        params.client.internal.pluginRuntimeOwnerId ===
          params.client.internal.runtimePluginToolGrant?.pluginId
          ? params.client.internal.runtimePluginToolGrant
          : undefined;

      dispatchAgentRunFromGateway({
        ingressOpts: {
          message,
          images: params.images,
          imageOrder: params.imageOrder,
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
          runContext: {
            messageChannel: params.delivery.originMessageChannel,
            accountId: params.delivery.resolvedAccountId,
            senderId: params.requestSenderId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            currentThreadTs:
              prepared.resolvedThreadId != null ? String(prepared.resolvedThreadId) : undefined,
          },
          ...(execApprovalFollowupRuntimeHandoff?.bashElevated
            ? { bashElevated: execApprovalFollowupRuntimeHandoff.bashElevated }
            : {}),
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          timeout: params.request.timeout?.toString(),
          bestEffortDeliver: params.bestEffortDeliver,
          messageChannel: params.delivery.originMessageChannel,
          runId: params.runId,
          requestMessageId: params.requestMessageId,
          lane: params.request.lane,
          modelRun: params.request.modelRun === true,
          promptMode: params.request.promptMode,
          extraSystemPrompt: params.request.extraSystemPrompt,
          bootstrapContextMode: params.request.bootstrapContextMode,
          bootstrapContextRunKind: params.effectiveBootstrapContextRunKind,
          toolsAllow: params.restoredCronContinuation?.toolsAllow,
          runtimePluginToolGrant,
          toolsAllowIsDefault: params.restoredCronContinuation?.toolsAllowIsDefault,
          requireExplicitMessageTarget:
            params.restoredCronContinuation?.cliSessionBindingFacts?.requireExplicitMessageTarget,
          cliSessionBindingFacts: params.restoredCronContinuation?.cliSessionBindingFacts,
          acpTurnSource: params.request.acpTurnSource,
          internalEvents: params.request.internalEvents,
          inputProvenance: params.inputProvenance,
          senderIsOwner: params.restoredCronContinuation
            ? true
            : clientHasAdminScope(params.client),
          sessionEffects: params.sessionEffects,
          skipInitialSessionTouch: params.skipAgentInitialSessionTouch,
          preserveUserFacingSessionModelState:
            params.preserveUserFacingSessionModelState && !params.restoredCronContinuation,
          sourceReplyDeliveryMode: params.restoredCronContinuation
            ? params.restoredCronContinuation.cliSessionBindingFacts?.sourceReplyDeliveryMode
            : params.request.sourceReplyDeliveryMode,
          disableMessageTool: params.request.disableMessageTool,
          forceRestartSafeTools: params.request.forceRestartSafeTools,
          internalDeliveryMediaUrls: params.client?.internal?.internalDeliveryMediaUrls,
          internalDeliverySuppressText: params.client?.internal?.internalDeliverySuppressText,
          suppressPromptPersistence:
            params.requestedPromptPersistenceSuppression ||
            shouldSuppressAgentPromptPersistence({
              inputProvenance: params.inputProvenance,
              internalEvents: params.request.internalEvents,
            }),
          userTurnTranscriptRecorder,
          cleanupBundleMcpOnRunEnd: params.request.cleanupBundleMcpOnRunEnd,
          abortSignal: prepared.activeRunAbort.controller.signal,
          lifecycleGeneration: params.lifecycleGeneration,
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
        respond: params.respond,
        context: params.context,
        taskTrackingMode: prepared.dispatchTaskTrackingMode,
      });
      dispatched = true;
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err));
      const payload = {
        runId: params.runId,
        status: "error" as const,
        summary: formatForLog(err),
      };
      if (acceptedExecutionBarrier && !acceptedExecutionBarrierPassed) {
        rejectedBarrierResponse = { error, payload };
      } else {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
          entry: { ts: Date.now(), ok: false, payload, error },
        });
        params.respond(false, payload, error, {
          runId: params.runId,
          error: formatForLog(err),
        });
      }
    } finally {
      if (!dispatched) {
        try {
          await params.releaseCronContinuationClaimWithRecovery();
        } finally {
          try {
            cleanupAdmittedRun({ force: true });
          } finally {
            if (rejectedBarrierResponse) {
              deleteGatewayDedupeEntries({
                dedupe: params.context.dedupe,
                keys: params.agentDedupeKeys,
              });
              params.respond(
                false,
                rejectedBarrierResponse.payload,
                rejectedBarrierResponse.error,
                {
                  runId: params.runId,
                  error: rejectedBarrierResponse.payload.summary,
                },
              );
            }
          }
        }
      }
    }
  });
}
