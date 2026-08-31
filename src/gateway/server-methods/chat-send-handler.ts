// chat.send owns admission, ACK timing, and detached dispatch handoff.
import { performance } from "node:perf_hooks";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import {
  lookupSessionGoalOperation,
  type SessionGoalOperation,
  type SessionGoalOperationResult,
} from "../../config/sessions/goals-operations.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitDiagnosticsTimelineEvent } from "../../infra/diagnostics-timeline.js";
import {
  recordSessionCreated,
  recordSessionGoalChanged,
} from "../../sessions/session-state-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import type { ChatRunTiming } from "../server-chat-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  terminalizeRestartSafeChatAdmission,
  type RestartSafeChatTerminalState,
} from "./chat-restart-recovery.js";
import { startChatDispatch } from "./chat-send-agent-dispatch.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { handleChatSendSetupError } from "./chat-send-dispatch-errors.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import {
  createChatSendMessageInjectionStarter,
  settleChatSendPreAckMessageInjection,
} from "./chat-send-message-injection.js";
import { applyChatSendReplyContextFields } from "./chat-send-reply-context.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  chatSendAckServerTimingAttributes,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
} from "./chat-server-timing.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChatSendInternalOptions = {
  goalResume?: SessionGoalOperation & { action: "resume" };
  trustedSystemInput?: boolean;
  toolsAllow?: string[];
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

async function handleChatSendWithOptions(
  {
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  }: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
  options?: ChatSendInternalOptions,
): Promise<void> {
  const setup = await prepareAndAdmitChatSend(
    { params, respond, context, client, sessionMutationAuthorization },
    onAdmissionOwned,
    options,
  );
  if (!setup) {
    return;
  }
  const { normalizedRequest, preparedSession, admitted } = setup;
  const { chatSendReceivedAtMs, clientInfo, p, systemInputProvenance, reconnectResumeRequested } =
    normalizedRequest.value;
  const {
    clientRunId,
    sessionLoadMs,
    cfg,
    storePath,
    entry,
    sessionKey,
    sessionRoutingChanged,
    selectedAgent,
  } = preparedSession.value;
  const {
    activeRunAbort,
    admittedSessionId,
    chatSendTraceAttributes,
    finishAbortedChatSend,
    interruptedActiveRun,
    lifecycleGeneration,
    messageInjectionTarget,
    restartSafeAdmission,
  } = admitted.value;
  const preparedAttachments = await prepareChatSendAttachments({
    request: normalizedRequest.value,
    session: preparedSession.value,
    admission: admitted.value,
    respond,
    context,
  });
  if (!preparedAttachments.ok) {
    return;
  }
  // Prepared inbound media has no transcript reference until the user turn
  // persists; every pre-ACK abandonment exit funnels through
  // cleanupAdmittedRun, which fires this armed discard. The hasPersisted gate
  // protects the restart-safe path, which persists durably before its abort
  // and routing exits; dispatch owns persistence after the ACK disarms this.
  let preparedMediaRecorder: UserTurnTranscriptRecorder | undefined;
  admitted.value.setDiscardAbandonedPreparedMedia(() => {
    if (
      !preparedMediaRecorder?.hasPersisted() &&
      !preparedMediaRecorder?.getPendingInputMessage?.()
    ) {
      void discardPreparedInboundMedia(preparedAttachments.value.offloadedRefs);
    }
  });
  if (activeRunAbort.controller.signal.aborted) {
    finishAbortedChatSend();
    return;
  }
  // Attachment preparation can suspend. Recheck immediately before the
  // synchronous ACK path so aborts and hot routing reloads cannot cross it.
  if (sessionRoutingChanged(context.getRuntimeConfig())) {
    admitted.value.rejectSessionRoutingChanged();
    return;
  }
  const { imageOrder, prepareAttachmentsMs } = preparedAttachments.value;
  const cronCreatorAuthority = externalAuthorityAdmission?.resolve({
    runId: clientRunId,
    sessionKey,
    spawnedBy: entry?.spawnedBy,
    client,
    inputProvenance: systemInputProvenance,
    hasExplicitOrigin: normalizedRequest.value.explicitOrigin !== undefined,
    hasRestoredCronContinuation: entry?.cronRunContinuation !== undefined,
    isIncognitoEntry: entry?.incognito === true,
    isReconnectResume: reconnectResumeRequested,
    isSystemGenerated:
      normalizedRequest.value.suppressCommandInterpretation ||
      normalizedRequest.value.systemProvenanceReceipt !== undefined,
    turnKind: normalizedRequest.value.turnKind,
  });

  const admissionStartedAt = Date.now();
  const terminalizeRestartSafeAdmission = async (
    terminalState: RestartSafeChatTerminalState,
  ): Promise<boolean> =>
    await terminalizeRestartSafeChatAdmission({
      admittedSessionId,
      clientRunId,
      sessionKey,
      startedAt: admissionStartedAt,
      storePath,
      ...terminalState,
    });
  let pendingStageAttempted = false;
  try {
    const userTurn = createGatewayChatUserTurnController({
      admission: admitted.value,
      client,
      request: normalizedRequest.value,
      session: preparedSession.value,
      startedAt: admissionStartedAt,
      warn: (message) => context.logGateway.warn(message),
      assertGoalCurrent: () => {
        sessionMutationCommitGuard?.();
        sessionMutationAuthorization?.assertCurrent();
        const currentConfig = context.getRuntimeConfig();
        const initialEntry = admitted.value.initialSessionEntry;
        if (initialEntry) {
          // Missing targets have no sharing owner yet; revalidate their creator before SQL commit.
          const currentTarget = loadSessionEntry(
            preparedSession.value.sessionLoadKey,
            preparedSession.value.sessionLoadOptions,
          );
          if (currentTarget.storePath !== storePath || currentTarget.canonicalKey !== sessionKey) {
            throw new Error("Session routing changed before Goal admission; refresh and retry.");
          }
          const creationError = authorizeGatewaySessionCreation({
            cfg: currentConfig,
            client,
            agentId: preparedSession.value.agentId,
          });
          if (creationError) {
            throw new SessionMutationAuthorizationChangedError(creationError);
          }
          const creation = resolveOperatorSessionCreation(client);
          if (
            creation.actor?.id !== initialEntry.createdActor?.id ||
            resolveCreatorSandbox(currentConfig, creation) !== initialEntry.sandbox
          ) {
            throw new Error("Session creation policy changed before Goal admission; retry.");
          }
        }
        if (
          activeRunAbort.controller.signal.aborted ||
          lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
          sessionRoutingChanged(currentConfig)
        ) {
          throw new Error("Goal admission changed before commit; refresh and retry.");
        }
      },
    });
    const {
      persist: persistGatewayUserTurnTranscript,
      recorder: userTurnRecorder,
      replyContextFieldsPromise,
    } = userTurn;
    preparedMediaRecorder = userTurnRecorder;
    admitted.value.setPendingInputCleanup(() => {
      userTurnRecorder.finishPendingInput?.(
        activeRunAbort.controller.signal.aborted &&
          activeRunAbort.entry?.abortStopReason !== "restart" &&
          !isAgentRunRestartAbortReason(activeRunAbort.controller.signal.reason)
          ? "cancelled"
          : "interrupted",
      );
    });
    const preparedUserTurn = prepareChatSendUserTurn({
      request: normalizedRequest.value,
      session: preparedSession.value,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      logGateway: context.logGateway,
      userTurn,
    });
    const { ctx, isInternalTextSlashCommandTurn } = preparedUserTurn;
    if (
      entry?.sessionId &&
      isOperatorUiClient(clientInfo) &&
      !isInternalTextSlashCommandTurn &&
      !normalizedRequest.value.goalOperation
    ) {
      // ACK transfers browser custody. Persist approved source bytes before
      // either a direct runtime or the in-memory collector can accept them.
      pendingStageAttempted = true;
      const staged = await userTurnRecorder.stageApproved?.({
        runId: clientRunId,
        assertCurrent: () => {
          admitted.value.assertWorkAdmissionCurrent();
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertCurrent();
          if (sessionRoutingChanged(context.getRuntimeConfig())) {
            throw new Error("Session routing changed before input admission; refresh and retry.");
          }
        },
      });
      if (userTurnRecorder.isPendingInputConsumed?.()) {
        admitted.value.cleanupAdmittedRun();
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        respond(true, { runId: clientRunId, status: "ok" }, undefined, {
          cached: true,
          runId: clientRunId,
        });
        return;
      }
      if (!staged) {
        throw new Error("Chat input was not durably admitted; refresh and retry.");
      }
      const approved = userTurnRecorder.getPendingInputMessage?.();
      const text =
        extractTextFromChatContent(approved?.content, {
          joinWith: "\n",
          normalizeText: (value) => value,
        }) ?? "";
      ctx.Body = ctx.BodyForAgent = ctx.RawBody = text;
      ctx.BodyForCommands = ctx.CommandBody = text;
      if (ctx.CommandTurn) {
        ctx.CommandTurn = { ...ctx.CommandTurn, body: text };
      }
    }
    let goalResult: SessionGoalOperationResult | undefined;
    if (restartSafeAdmission) {
      const persistedUserTurn = await persistGatewayUserTurnTranscript();
      const goalOperation = normalizedRequest.value.goalOperation;
      if (goalOperation) {
        const mutation = persistedUserTurn?.sessionTurnMutationResult;
        goalResult =
          mutation?.result ??
          lookupSessionGoalOperation({
            sessionKey,
            storePath,
            agentId: preparedSession.value.agentId,
            expectedSessionId: admittedSessionId,
            operation: goalOperation,
          });
        if (goalResult && (!persistedUserTurn || mutation?.replayed)) {
          admitted.value.cleanupAdmittedRun();
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          respond(true, { ...goalResult, replayed: true }, undefined, {
            cached: true,
            runId: clientRunId,
          });
          return;
        }
        if (!goalResult || !persistedUserTurn?.sessionEntry) {
          throw new Error("Goal and its input were not durably admitted.");
        }
        if (admitted.value.initialSessionEntry) {
          recordSessionCreated({
            sessionKey,
            agentId: preparedSession.value.agentId,
            entry: persistedUserTurn.sessionEntry,
          });
        }
        recordSessionGoalChanged({
          sessionKey,
          agentId: preparedSession.value.agentId,
          entry: persistedUserTurn.sessionEntry,
          actor: gatewayClientSessionCreator(client),
          summary: `goal ${goalOperation.action}`,
        });
        emitSessionsChanged(context, {
          sessionKey,
          agentId: preparedSession.value.agentId,
          reason: "goal",
        });
      }
      // A matching idempotency row and lifecycle claim commit atomically, so
      // retries adopt the durable turn without submitting it twice.
      if (
        !persistedUserTurn ||
        persistedUserTurn.sessionEntry?.status !== "running" ||
        persistedUserTurn.sessionEntry.restartRecoveryDeliveryRunId !== clientRunId
      ) {
        throw new Error("chat turn was not durably admitted");
      }
      if (lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        if (activeRunAbort.entry) {
          activeRunAbort.entry.abortStopReason = "restart";
        }
        activeRunAbort.controller.abort(createAgentRunRestartAbortError());
      }
      if (activeRunAbort.controller.signal.aborted) {
        if (
          !(await terminalizeRestartSafeAdmission({
            retryable: activeRunAbort.entry?.abortStopReason === "restart",
            status: "killed",
          }))
        ) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        finishAbortedChatSend();
        return;
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        if (!(await terminalizeRestartSafeAdmission({ retryable: true, status: "failed" }))) {
          throw new Error("chat admission ownership changed before terminalization");
        }
        admitted.value.rejectSessionRoutingChanged();
        return;
      }
    }

    const beginCapturedMessageInjection = createChatSendMessageInjectionStarter({
      target: messageInjectionTarget,
      request: normalizedRequest.value,
      session: preparedSession.value,
      turn: preparedUserTurn,
      imageOrder,
      userTurnTranscriptRecorder: userTurnRecorder,
    });
    const preAckReplyContextPromise =
      messageInjectionTarget && !isInternalTextSlashCommandTurn
        ? replyContextFieldsPromise
        : undefined;
    if (preAckReplyContextPromise) {
      applyChatSendReplyContextFields(ctx, await preAckReplyContextPromise);
      if (activeRunAbort.controller.signal.aborted) {
        return finishAbortedChatSend();
      }
      if (sessionRoutingChanged(context.getRuntimeConfig())) {
        return admitted.value.rejectSessionRoutingChanged();
      }
    }
    let messageInjectionAttempt =
      !p.replyToId || preAckReplyContextPromise ? beginCapturedMessageInjection() : undefined;
    const preAckInjection = await settleChatSendPreAckMessageInjection({
      attempt: messageInjectionAttempt,
      isAborted: () => activeRunAbort.controller.signal.aborted,
      sessionRoutingChanged: () => sessionRoutingChanged(context.getRuntimeConfig()),
      onAborted: finishAbortedChatSend,
      onSessionRoutingChanged: admitted.value.rejectSessionRoutingChanged,
    });
    if (preAckInjection.status === "handled") {
      return;
    }
    messageInjectionAttempt = preAckInjection.attempt;
    const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
      ? {
          receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
          loadSessionMs: sessionLoadMs,
          ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
        }
      : undefined;
    const chatSendTiming: ChatRunTiming | undefined =
      serverTiming && typeof client?.connId === "string" && client.connId.trim()
        ? {
            ackedAtMs: performance.now(),
            connId: client.connId.trim(),
            receivedAtMs: chatSendReceivedAtMs,
          }
        : undefined;
    context.addChatRun(clientRunId, {
      sessionKey,
      agentId: selectedAgent.agentId,
      clientRunId,
      ...(chatSendTiming ? { chatSendTiming } : {}),
    });
    // Only the recorder can attest transcript placement; custody and a started ACK cannot.
    const receipt = userTurnRecorder.getAdmissionReceipt?.();
    const ackPayload = {
      ...goalResult,
      runId: clientRunId,
      status: "started" as const,
      ...(receipt ? { messageSeq: receipt.activeMessagePosition + 1 } : {}),
      ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
      ...(serverTiming ? { serverTiming } : {}),
    };
    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "gateway.chat_send.ack_ready",
        phase: "agent-turn",
        attributes: {
          ...chatSendTraceAttributes,
          ackStatus: ackPayload.status,
          ...chatSendAckServerTimingAttributes(serverTiming),
        },
      },
      { config: cfg },
    );
    // After the ACK, dispatch owns the turn: its error lifecycle persists the
    // user transcript (which references the media) on every path, so a
    // post-ACK cleanupAdmittedRun must not race that persist with a discard.
    admitted.value.setDiscardAbandonedPreparedMedia(undefined);
    respond(true, ackPayload, undefined, { runId: clientRunId });
    context.recordClientActivity?.(client);
    const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
    startChatDispatch({
      admissionStartedAt,
      admission: admitted.value,
      attachments: preparedAttachments.value,
      client,
      context,
      toolsAllow: options?.toolsAllow,
      skillWorkshopProposalRevision: options?.skillWorkshopProposalRevision,
      cronCreatorAuthority,
      externalAuthorityAdmission,
      injection: {
        beginCapturedMessageInjection,
        messageInjectionAttempt,
        preAckReplyContextPromise,
        replyContextFieldsPromise,
      },
      request: normalizedRequest.value,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
      timing: {
        chatSendAckedAtMs,
        chatSendTiming,
      },
      turn: preparedUserTurn,
      userTurn,
    });
  } catch (err) {
    await handleChatSendSetupError({
      // Uncommitted Goal admissions may retry with their original identity. Committed
      // outcomes replay from the durable receipt instead of this transient error cache.
      cacheResult: normalizedRequest.value.goalOperation === undefined && !pendingStageAttempted,
      admission: admitted.value,
      context,
      error: err,
      respond,
      session: preparedSession.value,
      terminalizeRestartSafeAdmission,
    });
  }
}

export async function handleChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
  externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, externalAuthorityAdmission);
}

/** Operator Resume admits one hidden internal continuation with the Goal transition. */
export async function handleSessionGoalResumeChat(
  options: GatewayRequestHandlerOptions,
  operation: SessionGoalOperation & { action: "resume" },
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { goalResume: operation });
}

/** Dispatches an internally delegated turn within its caller-owned tool boundary. */
export async function handleChatSendWithRuntimeTools(
  options: GatewayRequestHandlerOptions,
  toolsAllow: string[],
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, { toolsAllow });
}

/** Dispatches an operator-requested proposal revision with its reviewed revision bound to the run. */
export async function handleChatSendWithSkillWorkshopProposalRevision(
  options: GatewayRequestHandlerOptions,
  proposalRevision: SkillWorkshopProposalRevisionConstraint,
): Promise<void> {
  await handleChatSendWithOptions(options, undefined, undefined, {
    toolsAllow: ["skill_workshop"],
    skillWorkshopProposalRevision: { ...proposalRevision },
  });
}

/** Dispatches Gateway-authored system input without widening the public chat-send contract. */
export async function handleTrustedInternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  await handleChatSendWithOptions(options, onAdmissionOwned, undefined, {
    trustedSystemInput: true,
  });
}
