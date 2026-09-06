import { asOptionalObjectRecord, asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import {
  emitAgentActivityEvent,
  type AgentCommandOutputEventData,
  type AgentItemEventData,
  type AgentPatchSummaryEventData,
} from "../infra/agent-activity-events.js";
import { emitAgentEvent, type AgentApprovalEventData } from "../infra/agent-events.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { projectProgressCardChannelUpdate } from "../session-cards/progress-card-channel-summary.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  consumeStructuredReplaySafeToolCall,
  consumeTrackedToolExecutionStarted,
} from "./agent-tools.before-tool-call.state.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import {
  isDeliveredCoreCurrentChannelWidgetResult,
  readEmbeddedMessageDeliveryFact,
} from "./embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  readMessageToolSourceReplyText,
  resolveMessageToolSourceReplyFinal,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
  isDeliveredMessagingToolSendToCurrentSource,
} from "./embedded-agent-messaging-extraction.js";
import {
  isMessagingTool,
  isPluginNativeMessagingTool,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";
import { mergeEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  applyCurrentMessageProvider,
  applyToolSendReceiptForExtraction,
  buildPatchSummaryText,
  buildProcessTerminalDiagnostic,
  didShellCronAddSucceed,
  emitToolResultOutput,
  extractExecOutput,
  extractLiveExecOutput,
  hasMessagingRichContent,
  hasTerminalControlCharacter,
  isAsyncStartedToolResult,
  isCronAddAction,
  isMiddlewareToolResultError,
  loadHookRunnerGlobal,
  readApplyPatchSummary,
  readAsyncStartedTaskIds,
  readExecToolDetails,
  readMessagingText,
  resolveFallbackToolTerminalObserver,
} from "./embedded-agent-subscribe.handlers.tools.results.js";
import {
  buildCommandItemId,
  buildCommandItemTitle,
  buildPatchItemId,
  buildPatchItemTitle,
  buildToolCallSummary,
  buildToolItemId,
  buildToolItemTitle,
  buildToolStartKey,
  emitAgentEventCallbackBestEffort,
  emitTrackedItemEvent,
  isExecToolName,
  toolStartData,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
} from "./embedded-agent-tool-media.js";
import {
  capLiveExecResult,
  extractToolErrorCode,
  extractToolErrorMessage,
  isToolResultTimedOut,
  sanitizeToolResult,
} from "./embedded-agent-tool-results.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import { readMcpConnectAction } from "./mcp-connect-action.js";
import { readMcpAppChannelView } from "./mcp-ui-resource.js";
import type { AgentEvent } from "./runtime/index.js";
import {
  createToolValidationErrorSummary,
  summarizeToolValidationError,
} from "./tool-error-summary.js";
import { resolveFileMutationToolName } from "./tool-mutation-names.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { isToolResultError, readToolResultDetails } from "./tool-result-error.js";
import { cancelAskUserPromptDelivery } from "./tools/ask-user-tool.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

/** Handles a tool-execution result and commits replay, media, hook, and error state. */
export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: Extract<AgentEvent, { type: "tool_execution_end" }>,
) {
  const rawToolName = evt.toolName;
  const toolName = normalizeToolPolicyName(rawToolName);
  const hideFromChannelProgress = evt.hideFromChannelProgress === true;
  const toolCallId = evt.toolCallId;
  ctx.state.liveEditDiffStateById.delete(toolCallId);
  if (toolName === "ask_user") {
    cancelAskUserPromptDelivery(toolCallId, ctx.params.sessionKey, ctx.params.runId);
  }
  const runId = ctx.params.runId;
  const isError = evt.isError;
  const result = evt.result;
  const toolSendReceiptResult = ctx.consumeToolSendReceipt?.(toolCallId);
  const observerIsError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const approvalUnavailable =
    isExecToolName(toolName) &&
    readExecToolDetails(sanitizedResult)?.status === "approval-unavailable";
  const isToolError = observerIsError && !approvalUnavailable;
  if (!isToolError) {
    const channelView = readMcpAppChannelView(result);
    if (channelView) {
      // A later successful app result supersedes the earlier launch target.
      ctx.state.latestMcpAppChannelView = channelView;
    }
    const connectAction = readMcpConnectAction(result);
    if (connectAction) {
      ctx.state.latestMcpConnectAction = connectAction;
    }
  }
  try {
    ctx.params.onAgentToolResult?.({
      toolName,
      result: sanitizedResult,
      isError: observerIsError,
    });
  } catch (error) {
    ctx.log.warn(`onAgentToolResult handler failed: tool=${toolName} error=${String(error)}`);
  }
  const eventResult = isExecToolName(toolName)
    ? capLiveExecResult(sanitizedResult)
    : sanitizedResult;
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  ctx.state.execLiveUpdateStateById?.delete(toolCallId);
  const initialCallSummary = ctx.state.toolMetaById.get(toolCallId);
  const initialArgs = asRecord(startData?.args);
  const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
  const trackedExecutionStarted = consumeTrackedToolExecutionStarted(toolCallId, runId);
  const executionPrevented = consumePreExecutionBlockedToolCall(toolCallId, runId);
  const structuredReplaySafe = consumeStructuredReplaySafeToolCall(toolCallId, runId);
  const startArgs = asOptionalObjectRecord(adjustedArgs) ?? initialArgs;
  const callSummary = buildToolCallSummary(
    toolName,
    startArgs,
    initialCallSummary?.meta,
    initialCallSummary?.instanceReplaySafe === true,
    initialCallSummary?.ownerKey,
    structuredReplaySafe,
  );
  // A racing observer can consume the active wrapper boundary. Settled and
  // custom producers use their terminal fact, while policy blocks override it.
  const executionStarted =
    (trackedExecutionStarted ?? evt.executionStarted ?? true) && !executionPrevented;
  const meta = callSummary.meta;
  const asyncStarted = !isToolError && isAsyncStartedToolResult(sanitizedResult);
  const asyncTaskIds = asyncStarted ? readAsyncStartedTaskIds(sanitizedResult) : {};
  // A Code Mode exec that returns "waiting" parked a run the model resumes via
  // `wait`; record that here so recovery can tell parked nested work apart
  // from any other still-active lifecycle item.
  const codeModeSuspended =
    !isToolError &&
    ctx.params.codeModeExecToolNames?.has(toolName) === true &&
    readToolResultDetails(sanitizedResult)?.status === "waiting";
  const terminate =
    result !== null &&
    typeof result === "object" &&
    "terminate" in result &&
    result.terminate === true;
  ctx.state.toolMetas.push({
    toolName,
    toolCallId,
    meta,
    replaySafe: callSummary.replaySafe,
    isError: observerIsError,
    ...(terminate ? { terminate: true } : {}),
    ...(asyncStarted ? { asyncStarted: true, ...asyncTaskIds } : {}),
    ...(codeModeSuspended ? { codeModeSuspended: true } : {}),
  });
  const acceptedSessionSpawn =
    toolName === "sessions_spawn" && !isToolError
      ? normalizeAcceptedSessionSpawnResult(sanitizedResult)
      : null;
  if (acceptedSessionSpawn) {
    ctx.state.acceptedSessionSpawns.push(acceptedSessionSpawn);
  }
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  const errorMessage = isToolError ? extractToolErrorMessage(sanitizedResult) : undefined;
  const errorCode = isToolError ? extractToolErrorCode(sanitizedResult) : undefined;
  const terminalDiagnostic = isToolError
    ? buildProcessTerminalDiagnostic(toolName, startArgs, sanitizedResult)
    : undefined;
  const terminalErrorMessage =
    terminalDiagnostic && errorMessage && hasTerminalControlCharacter(errorMessage)
      ? undefined
      : errorMessage;
  const validationErrorSummary =
    isToolError && evt.executionStarted === false && evt.errorKind === "argument-validation"
      ? createToolValidationErrorSummary(toolName)
      : undefined;
  const terminal = (ctx.params.observeToolTerminal ?? resolveFallbackToolTerminalObserver(ctx))({
    toolCallId,
    toolName,
    arguments: startArgs,
    result,
    ...(meta ? { meta } : {}),
    executionStarted,
    replaySafe: callSummary.replaySafe,
    outcome: isToolError ? "failure" : "success",
    ...(callSummary.ownerKey
      ? {
          ownerMutation: { ownerKey: callSummary.ownerKey },
        }
      : {}),
    ...(isToolError
      ? {
          failure: {
            ...(errorCode ? { errorCode } : {}),
            ...(terminalErrorMessage ? { error: terminalErrorMessage } : {}),
            ...(terminalDiagnostic ? { terminalDiagnostic } : {}),
            ...(validationErrorSummary ? { validationErrorSummary } : {}),
            timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
            middlewareError: isMiddlewareToolResultError(sanitizedResult) || undefined,
          },
        }
      : {}),
  });
  ctx.state.lastToolError = terminal.lastToolError;
  const terminalErrorStatus = terminal.executionStarted ? "failed" : "blocked";
  const toolErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (asyncStarted) {
    ctx.state.hadDeterministicSideEffect = true;
  }
  if (terminal.sideEffectEvidence || acceptedSessionSpawn || asyncStarted) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }

  // Commit messaging tool evidence on success, discard on error.
  const messagingArgs = applyCurrentMessageProvider(toolName, startArgs, ctx.params.messageChannel);
  const isMessagingInvocation = isMessagingTool(toolName);
  const isMessagingSend = isMessagingInvocation && isMessagingToolSendAction(toolName, startArgs);
  const hasMessagingTargetEvidence =
    isMessagingInvocation && isMessagingToolTargetEvidenceAction(toolName, startArgs);
  const messageDelivery = readEmbeddedMessageDeliveryFact(
    readToolResultDetails(toolSendReceiptResult)?.messageDelivery,
  );
  if (messageDelivery?.sourceReplyDelivered) {
    ctx.state.sourceReplyDelivered = true;
  }
  const didDeliverMessagingResult =
    isMessagingInvocation &&
    (messageDelivery
      ? messageDelivery.status === "settled" && (!isToolError || messageDelivery.partialDelivery)
      : isPluginNativeMessagingTool(toolName) &&
        isDeliveredMessagingToolResult({
          toolName,
          args: startArgs,
          result,
          hookResult: toolSendReceiptResult,
          isError: isToolError,
        }));
  const messageText = isMessagingSend ? readMessagingText(startArgs) : undefined;
  const argumentMediaUrls = isMessagingSend ? collectMessagingMediaUrlsFromRecord(startArgs) : [];
  const hasRichContent = isMessagingSend && hasMessagingRichContent(startArgs);
  const messageTarget = hasMessagingTargetEvidence
    ? extractMessagingToolSend(toolName, messagingArgs, {
        config: ctx.params.config,
        currentChannelId: ctx.params.currentChannelId,
        currentMessagingTarget: ctx.params.currentMessagingTarget,
        currentThreadId: ctx.params.currentThreadId,
        currentMessageId: ctx.params.currentMessageId,
        replyToMode: ctx.params.replyToMode,
        hasRepliedRef: startData?.hasRepliedRef,
      })
    : undefined;
  const committedMediaUrls =
    didDeliverMessagingResult && isMessagingSend
      ? [...argumentMediaUrls, ...collectMessagingMediaUrlsFromToolResult(result)]
      : [];
  const extractionResult = applyToolSendReceiptForExtraction(result, toolSendReceiptResult);
  const confirmedMessageTarget =
    messageTarget && extractMessagingToolSendResult(messageTarget, extractionResult);
  const deliveredMessageToolSourceReply =
    didDeliverMessagingResult &&
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: ctx.params.sourceReplyDeliveryMode,
      toolName,
      args: startArgs,
      result,
      hookResult: toolSendReceiptResult,
      isError: isToolError,
      allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
        send: confirmedMessageTarget,
        config: ctx.params.config,
        currentProvider: ctx.params.messageChannel,
        currentAccountId: ctx.params.currentAccountId,
        currentChannelId: ctx.params.currentChannelId,
        currentMessagingTarget: ctx.params.currentMessagingTarget,
        currentThreadId: ctx.params.currentThreadId,
        sessionKey: ctx.params.sessionKey,
        deliveredPayload: extractionResult,
      }),
      deliveryConfirmed: didDeliverMessagingResult,
    });
  const deliveredCurrentSourceReply =
    deliveredMessageToolSourceReply ||
    isDeliveredCoreCurrentChannelWidgetResult({
      coreBuiltinToolNames: ctx.params.coreBuiltinToolNames,
      sourceReplyDeliveryMode: ctx.params.sourceReplyDeliveryMode,
      toolName,
      result,
      isToolError,
    });
  const sourceReplyFinal = deliveredMessageToolSourceReply
    ? resolveMessageToolSourceReplyFinal(startArgs)
    : undefined;
  ctx.state.pendingMessagingTexts.delete(toolCallId);
  ctx.state.pendingMessagingTargets.delete(toolCallId);
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  if (didDeliverMessagingResult && messageText) {
    ctx.state.messagingToolSentTexts.push(messageText);
    ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(messageText));
    ctx.log.debug(`Committed messaging text: tool=${toolName} len=${messageText.length}`);
    ctx.trimMessagingToolSent();
  }
  if (didDeliverMessagingResult && confirmedMessageTarget) {
    ctx.state.messagingToolSentTargets.push({
      ...confirmedMessageTarget,
      ...(messageText ? { text: messageText } : {}),
      ...(committedMediaUrls.length > 0 ? { mediaUrls: committedMediaUrls.slice() } : {}),
      ...(hasRichContent ? { hasRichContent: true as const } : {}),
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    });
    ctx.trimMessagingToolSent();
  }
  if (deliveredCurrentSourceReply) {
    ctx.state.messageToolOnlySourceReplyDelivered = true;
    if (deliveredMessageToolSourceReply) {
      const sourceReplyText = readMessageToolSourceReplyText(startArgs);
      const normalizedSourceReplyText = sourceReplyText
        ? normalizeTextForComparison(sourceReplyText)
        : "";
      if (normalizedSourceReplyText) {
        ctx.state.currentSourceMessagingToolSentTextsNormalized.push(normalizedSourceReplyText);
        ctx.trimMessagingToolSent();
      }
    }
    ctx.params.onDeliveredMessageToolOnlySourceReply?.();
  }
  if (didDeliverMessagingResult && isMessagingSend) {
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
    const sourceReplyPayload = extractMessagingToolSourceReplyPayload(result);
    if (sourceReplyPayload) {
      ctx.state.messagingToolSourceReplyPayloads.push({
        ...sourceReplyPayload,
        ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
      });
      ctx.trimMessagingToolSent();
    }
  }
  // Track committed reminders only when cron.add completed successfully.
  if (
    !isToolError &&
    ((isAutomationsToolName(toolName) && isCronAddAction(startArgs)) ||
      (isExecToolName(toolName) && didShellCronAddSucceed(startArgs, result)))
  ) {
    ctx.state.successfulCronAdds += 1;
  }
  if (!isToolError && toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const details =
      result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
    const response = normalizeHeartbeatToolResponse(details);
    if (response) {
      const isFirstHeartbeatResponse = ctx.state.heartbeatToolResponse === undefined;
      ctx.state.heartbeatToolResponse = response;
      if (isFirstHeartbeatResponse) {
        runBestEffortCallback({
          label: "heartbeat tool response",
          log: ctx.log,
          callback: () => ctx.params.onHeartbeatToolResponse?.(response),
        });
      }
    }
  }

  const planUpdate =
    !isToolError && toolName === "progress_card"
      ? projectProgressCardChannelUpdate(startArgs)
      : undefined;
  if (planUpdate) {
    const planEvent = {
      stream: "plan" as const,
      data: {
        phase: "update",
        title: "Plan updated",
        source: "openclaw",
        ...planUpdate,
      },
    };
    emitAgentEvent({ runId: ctx.params.runId, ...planEvent });
    emitAgentEventCallbackBestEffort(ctx, planEvent);
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      commandBearing: callSummary.commandBearing,
      result: eventResult,
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
  });
  const endedAt = Date.now();
  const itemId = buildToolItemId(toolCallId);
  const itemData: AgentItemEventData = {
    itemId,
    phase: "end",
    kind: "tool",
    title: buildToolItemTitle(toolName, meta),
    status: isToolError ? terminalErrorStatus : "completed",
    name: toolName,
    meta,
    commandBearing: callSummary.commandBearing,
    toolCallId,
    startedAt: startData?.startTime,
    endedAt,
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    ...(callSummary.commandBearing && !isExecToolName(toolName)
      ? { suppressChannelProgress: true }
      : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  emitTrackedItemEvent(ctx, itemData);
  emitAgentEventCallbackBestEffort(ctx, {
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      commandBearing: callSummary.commandBearing,
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
  });

  if (isExecToolName(toolName)) {
    // Use sanitizedResult so `aggregated` is redacted before reaching command_output.
    const execDetails = readExecToolDetails(sanitizedResult);
    const commandItemId = buildCommandItemId(toolCallId);
    if (
      execDetails?.status === "approval-pending" ||
      execDetails?.status === "approval-unavailable"
    ) {
      const approvalStatus = execDetails.status === "approval-pending" ? "pending" : "unavailable";
      const approvalData: AgentApprovalEventData = {
        phase: "requested",
        kind: "exec",
        status: approvalStatus,
        title:
          approvalStatus === "pending"
            ? "Command approval requested"
            : "Command approval unavailable",
        itemId: commandItemId,
        toolCallId,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
            }
          : {}),
        command: execDetails.command,
        host: execDetails.host,
        ...(execDetails.status === "approval-unavailable" ? { reason: execDetails.reason } : {}),
        message: execDetails.warningText,
      };
      emitAgentActivityEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        stream: "approval",
        data: approvalData,
      });
      emitAgentEventCallbackBestEffort(ctx, {
        stream: "approval",
        data: approvalData,
      });
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: "blocked",
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
              summary: "Awaiting approval before command can run.",
            }
          : {
              summary: "Command is blocked because no interactive approval route is available.",
            }),
      });
    } else {
      const output = extractLiveExecOutput(eventResult);
      const rawOutput = extractExecOutput(sanitizedResult);
      const commandStatus =
        execDetails?.status === "failed" || isToolError ? terminalErrorStatus : "completed";
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: commandStatus,
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(output ? { summary: output } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
      });
      const outputData: AgentCommandOutputEventData = {
        itemId: commandItemId,
        phase: "end",
        title: buildCommandItemTitle(toolName, meta),
        toolCallId,
        name: toolName,
        ...(output ? { output } : {}),
        status: commandStatus,
        ...(execDetails && "exitCode" in execDetails ? { exitCode: execDetails.exitCode } : {}),
        ...(execDetails &&
        "durationMs" in execDetails &&
        typeof execDetails.durationMs === "number" &&
        Number.isFinite(execDetails.durationMs) &&
        execDetails.durationMs >= 0
          ? { durationMs: execDetails.durationMs }
          : {}),
        ...(execDetails && "cwd" in execDetails && typeof execDetails.cwd === "string"
          ? { cwd: execDetails.cwd }
          : {}),
      };
      emitAgentActivityEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        stream: "command_output",
        data: outputData,
      });
      emitAgentEventCallbackBestEffort(ctx, {
        stream: "command_output",
        data: outputData,
      });

      if (typeof rawOutput === "string") {
        const parsedApprovalResult = parseExecApprovalResultText(rawOutput);
        if (parsedApprovalResult.kind === "denied") {
          const approvalData: AgentApprovalEventData = {
            phase: "resolved",
            kind: "exec",
            status: normalizeOptionalLowercaseString(parsedApprovalResult.metadata)?.includes(
              "approval-request-failed",
            )
              ? "failed"
              : "denied",
            title: "Command approval resolved",
            itemId: commandItemId,
            toolCallId,
            message: parsedApprovalResult.body || parsedApprovalResult.raw,
          };
          emitAgentActivityEvent({
            runId: ctx.params.runId,
            ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
            stream: "approval",
            data: approvalData,
          });
          emitAgentEventCallbackBestEffort(ctx, {
            stream: "approval",
            data: approvalData,
          });
        }
      }
    }
  }

  if (resolveFileMutationToolName(toolName) === "apply_patch") {
    const patchSummary = readApplyPatchSummary(sanitizedResult);
    const patchItemId = buildPatchItemId(toolCallId);
    const summaryText = patchSummary ? buildPatchSummaryText(patchSummary) : undefined;
    emitTrackedItemEvent(ctx, {
      itemId: patchItemId,
      phase: "end",
      kind: "patch",
      title: buildPatchItemTitle(meta),
      status: isToolError ? "failed" : "completed",
      name: toolName,
      meta,
      toolCallId,
      startedAt: startData?.startTime,
      endedAt,
      ...(summaryText ? { summary: summaryText } : {}),
      ...(isToolError && extractToolErrorMessage(sanitizedResult)
        ? { error: extractToolErrorMessage(sanitizedResult) }
        : {}),
    });
    if (patchSummary) {
      const patchData: AgentPatchSummaryEventData = {
        itemId: patchItemId,
        phase: "end",
        title: buildPatchItemTitle(meta),
        toolCallId,
        name: toolName,
        added: patchSummary.added,
        modified: patchSummary.modified,
        deleted: patchSummary.deleted,
        summary: summaryText ?? buildPatchSummaryText(patchSummary),
      };
      emitAgentActivityEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        stream: "patch",
        data: patchData,
      });
      emitAgentEventCallbackBestEffort(ctx, {
        stream: "patch",
        data: patchData,
      });
    }
  }

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  if (!planUpdate) {
    await emitToolResultOutput({
      ctx,
      toolName,
      rawToolName,
      meta,
      isToolError,
      result,
      sanitizedResult,
    });
  }
  await Promise.resolve(ctx.params.onToolStreamBoundary?.()).catch((error: unknown) => {
    ctx.log.debug(`embedded run tool stream boundary callback failed: ${String(error)}`);
  });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: startArgs,
      runId,
      toolCallId,
      result: sanitizedResult,
      error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
      durationMs,
    };
    void hookRunnerAfter
      .runAfterToolCall(hookEvent, {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        sessionId: ctx.params.sessionId,
        runId,
        toolCallId,
      })
      .catch((err: unknown) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
  terminal.executedArguments ??= startArgs;
  return Object.assign(terminal, { isError: observerIsError });
}
