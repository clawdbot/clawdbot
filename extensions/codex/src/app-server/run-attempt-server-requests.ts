import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { isCodexAppServerApprovalRequest } from "./client.js";
import { shouldAutoApproveCodexAppServerApprovals } from "./config.js";
import {
  emitDynamicToolErrorDiagnostic,
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  hasPendingDynamicToolTerminalDiagnostic,
  isDynamicToolTerminalDiagnosticEvent,
  isMatchingDynamicToolTerminalDiagnostic,
  resolveDynamicToolCallTimeoutMs,
  shouldBlockTerminalReleaseForNonTerminalDynamicToolResult,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { shouldEmitTranscriptToolProgress } from "./event-projector.js";
import { readCodexDynamicToolCallParams } from "./protocol-validators.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { handleApprovalRequest, toTranscriptToolResult } from "./run-attempt-tools.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  inferCodexDynamicToolMeta,
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";
import type { CodexAppServerServerRequest, CodexThreadRouteScope } from "./turn-router.js";

export function createCodexAttemptServerRequestController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
) {
  const { prompt, state: resourceState, projectorRef, trajectoryRecorder } = resources;
  const { context } = prompt;
  const { runtime, attemptTools } = context;
  const { connection } = runtime;
  const { params, computerUseConfig, runAbortController, appServer, sessionAgentId } = connection;
  const {
    toolBridge,
    toolOutcomeOrdinals,
    suppressedDynamicToolOutcomeOrdinals,
    allocateCodexToolOutcomeOrdinal,
  } = attemptTools;
  const {
    state,
    turnIdRef,
    userInputBridgeRef,
    openClawDynamicToolExecutions,
    pendingOpenClawDynamicToolCompletionIds,
    postToolRawAssistantCompletionIdleTimeoutMs,
    turnWatches,
  } = turnRuntime;
  const {
    emitExecutionPhaseOnce,
    scheduleTurnReleaseAfterTerminalDynamicTool,
    scheduleTerminalDynamicToolReleaseCheck,
  } = lifecycle;
  const handleServerRequest = async (
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
  ) => {
    const turnId = turnIdRef.current;
    const projector = projectorRef.current;
    let armCompletionWatchOnResponse = false;
    let requestCountsAsTurnActivity = false;
    const markCurrentTurnRequestProgress = () => {
      state.activeAppServerTurnRequests += 1;
      turnWatches.clearCompletionIdleTimer();
      turnWatches.disarmAssistantCompletionIdleWatch();
      requestCountsAsTurnActivity = true;
      turnWatches.touchActivity(`request:${request.method}:start`, { attemptProgress: true });
    };
    try {
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        if (!scope.turnId || scope.turnId === turnId) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return await handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: resourceState.thread.threadId,
          turnId,
          pluginAppPolicyContext: resourceState.thread.pluginAppPolicyContext,
          ...(computerUseConfig.enabled
            ? { computerUseMcpServerName: computerUseConfig.mcpServerName }
            : {}),
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        if (scope.turnId === turnId) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return userInputBridgeRef.current?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (scope.turnId === turnId) {
            armCompletionWatchOnResponse = true;
            markCurrentTurnRequestProgress();
          }
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: resourceState.thread.threadId,
            turnId,
            nativeHookRelay: resourceState.nativeHookRelay,
            autoApprove: shouldAutoApproveCodexAppServerApprovals(appServer),
            signal: runAbortController.signal,
            onNativeToolFailureDisposition: (itemId, disposition) =>
              projector?.recordNativeToolApprovalFailure(itemId, disposition),
          });
        }
        return undefined;
      }
      const call = readCodexDynamicToolCallParams(request.params);
      if (!call || call.threadId !== resourceState.thread.threadId || call.turnId !== turnId) {
        return undefined;
      }
      const replayedExecution = openClawDynamicToolExecutions.get(call);
      if (replayedExecution) {
        armCompletionWatchOnResponse = true;
        markCurrentTurnRequestProgress();
        state.turnCrossedToolHandoff = true;
        return toCodexDynamicToolProtocolResponse(await replayedExecution) as JsonValue;
      }
      const toolCallOrdinal = allocateCodexToolOutcomeOrdinal?.(call.callId);
      armCompletionWatchOnResponse = true;
      markCurrentTurnRequestProgress();
      state.turnCrossedToolHandoff = true;
      pendingOpenClawDynamicToolCompletionIds.add(call.callId);
      trajectoryRecorder?.recordEvent("tool.call", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        arguments: call.arguments,
      });
      projector?.recordDynamicToolCall({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
      });
      emitExecutionPhaseOnce(`tool:${call.callId}`, {
        phase: "tool_execution_started",
        tool: call.tool,
        toolCallId: call.callId,
      });
      emitDynamicToolStartedDiagnostic({
        call,
        agentId: sessionAgentId,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      const toolMeta = inferCodexDynamicToolMeta(
        call,
        resolveCodexToolProgressDetailMode(params.toolProgressDetail),
      );
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
        void emitCodexAppServerEvent(params, {
          stream: "tool",
          data: {
            phase: "start",
            name: call.tool,
            toolCallId: call.callId,
            ...(toolMeta ? { meta: toolMeta } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
          },
        });
      }
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({ call, config: params.config });
      const toolStartedAt = Date.now();
      let terminalDiagnosticObserved = false;
      const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent((event) => {
        if (
          isDynamicToolTerminalDiagnosticEvent(event) &&
          isMatchingDynamicToolTerminalDiagnostic({
            event,
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          terminalDiagnosticObserved = true;
        }
      });
      try {
        const { execution } = openClawDynamicToolExecutions.claim(call, () =>
          handleDynamicToolCallWithTimeout({
            call,
            toolBridge,
            signal: runAbortController.signal,
            timeoutMs: dynamicToolTimeoutMs,
            toolCallOrdinal,
            onAgentToolResult: params.onAgentToolResult,
            onFallbackSelected: () => {
              if (toolCallOrdinal !== undefined) {
                suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
              }
            },
            onTimeout: () => {
              trajectoryRecorder?.recordEvent("tool.timeout", {
                threadId: call.threadId,
                turnId: call.turnId,
                toolCallId: call.callId,
                name: call.tool,
                timeoutMs: dynamicToolTimeoutMs,
              });
            },
          }),
        );
        const response = await execution;
        const protocolResponse = toCodexDynamicToolProtocolResponse(response);
        if (!protocolResponse.success && toolCallOrdinal !== undefined) {
          suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
          params.onToolOutcome?.({
            toolName: call.tool,
            argsHash: "",
            resultHash: "",
            toolCallOrdinal,
            terminalPresentation: undefined,
            presentationOnly: true,
          });
        }
        const toolDurationMs = Math.max(0, Date.now() - toolStartedAt);
        trajectoryRecorder?.recordEvent("tool.result", {
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          name: call.tool,
          success: protocolResponse.success,
          contentItems: protocolResponse.contentItems,
        });
        projector?.recordDynamicToolResult({
          callId: call.callId,
          tool: call.tool,
          asyncStarted: response.asyncStarted === true,
          success: protocolResponse.success,
          terminalType:
            response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
          sideEffectEvidence: response.sideEffectEvidence === true,
          contentItems: protocolResponse.contentItems,
        });
        if (shouldEmitDynamicToolProgress) {
          const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);
          void emitCodexAppServerEvent(params, {
            stream: "tool",
            data: {
              phase: "result",
              name: call.tool,
              toolCallId: call.callId,
              ...(toolMeta ? { meta: toolMeta } : {}),
              isError: !protocolResponse.success,
              result: toTranscriptToolResult(progressResponse),
            },
          });
        }
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolTerminalDiagnostic({
            response,
            call,
            agentId: sessionAgentId,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: toolDurationMs,
          });
        }
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (response.terminate === true) {
          scheduleTurnReleaseAfterTerminalDynamicTool({
            call,
            response,
            durationMs: toolDurationMs,
          });
        } else if (!shouldBlockTerminalReleaseForNonTerminalDynamicToolResult(response)) {
          scheduleTerminalDynamicToolReleaseCheck();
        } else {
          state.currentTurnHadNonTerminalDynamicToolResult = true;
          state.pendingTerminalDynamicToolRelease = undefined;
        }
        return protocolResponse as JsonValue;
      } catch (error) {
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolErrorDiagnostic({
            call,
            agentId: sessionAgentId,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        throw error;
      } finally {
        toolOutcomeOrdinals.delete(call.callId);
        unsubscribeToolDiagnosticObserver();
      }
    } finally {
      if (requestCountsAsTurnActivity) {
        state.activeAppServerTurnRequests = Math.max(0, state.activeAppServerTurnRequests - 1);
        const postToolContinuationTimeoutMs =
          request.method === "item/tool/call" && state.turnCrossedToolHandoff
            ? postToolRawAssistantCompletionIdleTimeoutMs
            : undefined;
        turnWatches.touchActivity(`request:${request.method}:response`, {
          arm: armCompletionWatchOnResponse,
          attemptProgress: true,
          ...(postToolContinuationTimeoutMs !== undefined
            ? { attemptTimeoutMs: postToolContinuationTimeoutMs }
            : {}),
        });
        if (armCompletionWatchOnResponse && postToolContinuationTimeoutMs !== undefined) {
          turnWatches.armCompletionIdleWatch({ timeoutMs: postToolContinuationTimeoutMs });
        }
        scheduleTerminalDynamicToolReleaseCheck();
      } else {
        turnWatches.scheduleProgressWatches();
      }
    }
  };
  return { handleServerRequest };
}
