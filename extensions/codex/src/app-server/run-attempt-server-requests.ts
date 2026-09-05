import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
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
import { recordCodexDynamicToolResult } from "./dynamic-tool-result-projection.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { shouldEmitTranscriptToolProgress } from "./event-projector-tool-progress.js";
import { readCodexDynamicToolCallParams } from "./protocol-validators.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { toTranscriptToolResult } from "./run-attempt-tools.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import {
  inferCodexDynamicToolMeta,
  isCodexCommandBearingToolCall,
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
} from "./tool-progress-normalization.js";
import type { CodexAppServerServerRequest, CodexThreadRouteScope } from "./turn-router.js";

const DYNAMIC_TOOL_TERMINAL_DIAGNOSTIC_TYPES = [
  "tool.execution.completed",
  "tool.execution.error",
  "tool.execution.blocked",
] as const;

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
  const autoApprove = shouldAutoApproveCodexAppServerApprovals(appServer);
  const {
    compactionPlanState,
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
    noteProgress,
  } = turnRuntime;
  const {
    emitExecutionPhaseOnce,
    scheduleTurnReleaseAfterTerminalDynamicTool,
    scheduleTerminalDynamicToolReleaseCheck,
  } = lifecycle;
  let pluginRefreshDrain: ReturnType<typeof createDeferred<void>> | undefined;
  let pluginRefreshStopping = false;
  const settlePluginRuntimeRefresh = async (turnId: string) => {
    if (!params.pluginRuntimeRefreshPending?.()) {
      return;
    }
    pluginRefreshDrain ??= createDeferred<void>();
    if (!pluginRefreshStopping && pendingOpenClawDynamicToolCompletionIds.size === 0) {
      pluginRefreshStopping = true;
      state.pendingTerminalDynamicToolRelease = undefined;
      turnRuntime.steeringQueueRef.current?.cancel();
      // Native dynamic-tool replies resume the model immediately. Keep them behind
      // this barrier until every host result is persisted and the old turn has stopped.
      void turnRuntime.interruptTurn(turnId, { locallyCompleted: true }).then(() => {
        turnRuntime.completeTurn();
        pluginRefreshDrain!.resolve();
      }, pluginRefreshDrain.reject);
    }
    await pluginRefreshDrain.promise;
  };
  const handleServerRequest = async (
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
    requestSignal: AbortSignal = new AbortController().signal,
  ) => {
    const signal = AbortSignal.any([runAbortController.signal, requestSignal]);
    const turnId = turnIdRef.current;
    const projector = projectorRef.current;
    let requestCountsAsTurnActivity = false;
    const markCurrentTurnRequestProgress = () => {
      state.activeAppServerTurnRequests += 1;
      requestCountsAsTurnActivity = true;
      noteProgress(`request:${request.method}:start`);
    };
    try {
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        if (!scope.turnId || scope.turnId === turnId) {
          markCurrentTurnRequestProgress();
        }
        const approvalResult = await routeCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: resourceState.thread.threadId,
          turnId,
          autoApproveMcpTools: autoApprove,
          projectedMcpServers: runtime.bundleMcpThreadConfig.configPatch?.mcp_servers,
          getActiveMcpToolCall: (serverName) => projector?.getActiveMcpToolCall(serverName),
          pluginAppPolicyContext: resourceState.thread.pluginAppPolicyContext,
          ...(computerUseConfig.enabled
            ? { computerUseMcpServerName: computerUseConfig.mcpServerName }
            : {}),
          signal,
        });
        if (approvalResult.kind === "handled") {
          return approvalResult.response;
        }
        return await userInputBridgeRef.current?.handleElicitationRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        if (scope.turnId === turnId) {
          markCurrentTurnRequestProgress();
        }
        return await userInputBridgeRef.current?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (scope.turnId === turnId) {
            markCurrentTurnRequestProgress();
          }
          return await handleCodexAppServerApprovalRequest({
            method: request.method,
            requestParams: request.params,
            paramsForRun: params,
            threadId: resourceState.thread.threadId,
            turnId,
            nativeHookRelay: resourceState.nativeHookRelay,
            autoApprove,
            signal,
            onNativeToolFailureDisposition: (itemId, disposition, approvalKind) =>
              projector?.recordNativeToolApprovalFailure(itemId, disposition, approvalKind),
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
        markCurrentTurnRequestProgress();
        return toCodexDynamicToolProtocolResponse(await replayedExecution) as JsonValue;
      }
      const toolCallOrdinal = allocateCodexToolOutcomeOrdinal?.(call.callId);
      markCurrentTurnRequestProgress();
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
      const toolMeta = inferCodexDynamicToolMeta(
        call,
        resolveCodexToolProgressDetailMode(params.toolProgressDetail),
      );
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const commandBearing = isCodexCommandBearingToolCall(call.tool, toolArgs);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
        void emitCodexAppServerEvent(params, {
          stream: "tool",
          data: {
            phase: "start",
            name: call.tool,
            itemId: call.callId,
            toolCallId: call.callId,
            ...(toolMeta ? { meta: toolMeta } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
            ...(commandBearing ? { commandBearing: true } : {}),
          },
        });
      }
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({ call, config: params.config });
      const toolStartedAt = Date.now();
      let terminalDiagnosticObserved = false;
      const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent(
        (event) => {
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
        },
        { include: DYNAMIC_TOOL_TERMINAL_DIAGNOSTIC_TYPES },
      );
      try {
        const { execution } = openClawDynamicToolExecutions.claim(call, async () => {
          // Publish the execution claim before persistence yields, so a replay
          // cannot become another owner of this call's progress or result.
          await projector?.transcriptCheckpoint.flush();
          emitDynamicToolStartedDiagnostic({
            call,
            agentId: sessionAgentId,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          });
          const response = await handleDynamicToolCallWithTimeout({
            call,
            toolBridge,
            signal,
            timeoutMs: dynamicToolTimeoutMs,
            toolMeta,
            toolCallOrdinal,
            onAgentToolResult: params.onAgentToolResult,
            observeToolTerminal: params.observeToolTerminal,
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
          });
          recordCodexDynamicToolResult(
            projector,
            call,
            response,
            toCodexDynamicToolProtocolResponse(response),
          );
          await projector?.transcriptCheckpoint.flush();
          return response;
        });
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
        if (protocolResponse.success && call.tool === "progress_card") {
          const progressCardInput = response.executedArguments ?? call.arguments;
          await projector?.recordDynamicProgressCardUpdate(progressCardInput);
          compactionPlanState.recordProgressCardInput(progressCardInput);
        }
        if (shouldEmitDynamicToolProgress) {
          const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);
          void emitCodexAppServerEvent(params, {
            stream: "tool",
            data: {
              phase: "result",
              name: call.tool,
              itemId: call.callId,
              toolCallId: call.callId,
              ...(toolMeta ? { meta: toolMeta } : {}),
              ...(commandBearing ? { commandBearing: true } : {}),
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
        if (params.pluginRuntimeRefreshPending?.()) {
          await settlePluginRuntimeRefresh(call.turnId);
        } else if (response.terminate === true && response.success) {
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
        await settlePluginRuntimeRefresh(call.turnId);
        throw error;
      } finally {
        toolOutcomeOrdinals.delete(call.callId);
        unsubscribeToolDiagnosticObserver();
      }
    } finally {
      if (requestCountsAsTurnActivity) {
        state.activeAppServerTurnRequests -= 1;
        noteProgress(`request:${request.method}:response`);
        scheduleTerminalDynamicToolReleaseCheck();
      }
    }
  };
  return { handleServerRequest };
}
