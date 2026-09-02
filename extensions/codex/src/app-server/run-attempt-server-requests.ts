import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  buildCodexAppServerApprovalRejectionResponse,
  handleCodexAppServerApprovalRequest,
} from "./approval-bridge.js";
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
import {
  createCommittedFinalSourceReplyResponse,
  createFailedDynamicToolResponse,
} from "./dynamic-tool-response-state.js";
import { recordCodexDynamicToolResult } from "./dynamic-tool-result-projection.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
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
import { createCodexUserInputCancellationResponse } from "./user-input-bridge.js";

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
    commitFinalSourceReplyDelivery,
    commitFinalSourceReply,
    emitExecutionPhaseOnce,
    scheduleTurnReleaseAfterTerminalDynamicTool,
    scheduleTerminalDynamicToolReleaseCheck,
  } = lifecycle;
  const handleServerRequest = async (
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
    requestSignal: AbortSignal = new AbortController().signal,
  ) => {
    const requestAdmission = turnRuntime.serverRequestAdmission.admit({
      // Once dispatched, a dynamic tool owns its terminal side-effect outcome.
      // Final source delivery rejects later calls but drains existing owners.
      preserveOnSeal: request.method === "item/tool/call",
    });
    const signal = AbortSignal.any([
      runAbortController.signal,
      requestSignal,
      requestAdmission.signal,
    ]);
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
        if (state.finalSourceReplyCommit && (!scope.turnId || scope.turnId === turnId)) {
          return createCodexElicitationResponse("decline");
        }
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
        if (state.finalSourceReplyCommit || requestAdmission.signal.aborted) {
          return createCodexElicitationResponse("decline");
        }
        if (approvalResult.kind === "handled") {
          return approvalResult.response;
        }
        const response = await userInputBridgeRef.current?.handleElicitationRequest({
          id: request.id,
          params: request.params,
        });
        return state.finalSourceReplyCommit || requestAdmission.signal.aborted
          ? createCodexElicitationResponse("decline")
          : response;
      }
      if (request.method === "item/tool/requestUserInput") {
        if (state.finalSourceReplyCommit && scope.turnId === turnId) {
          return createCodexUserInputCancellationResponse();
        }
        if (scope.turnId === turnId) {
          markCurrentTurnRequestProgress();
        }
        const response = await userInputBridgeRef.current?.handleRequest({
          id: request.id,
          params: request.params,
        });
        return state.finalSourceReplyCommit || requestAdmission.signal.aborted
          ? createCodexUserInputCancellationResponse()
          : response;
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (state.finalSourceReplyCommit && scope.turnId === turnId) {
            return buildCodexAppServerApprovalRejectionResponse(request.method, request.params);
          }
          if (scope.turnId === turnId) {
            markCurrentTurnRequestProgress();
          }
          const response = await handleCodexAppServerApprovalRequest({
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
          return state.finalSourceReplyCommit || requestAdmission.signal.aborted
            ? buildCodexAppServerApprovalRejectionResponse(request.method, request.params)
            : response;
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
      if (state.finalSourceReplyCommit) {
        const { execution } = openClawDynamicToolExecutions.claim(call, async () => {
          const response = createFailedDynamicToolResponse(
            "OpenClaw rejected this dynamic tool call because the final source reply already ended the turn.",
            { executionStarted: false, terminalReason: "cancelled" },
          );
          const protocolResponse = toCodexDynamicToolProtocolResponse(response);
          trajectoryRecorder?.recordEvent("tool.call", {
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            name: call.tool,
            arguments: call.arguments,
            rejectedAfterFinalSourceReply: true,
          });
          projector?.recordDynamicToolCall({
            callId: call.callId,
            tool: call.tool,
            arguments: call.arguments,
          });
          recordCodexDynamicToolResult(projector, call, response, protocolResponse);
          trajectoryRecorder?.recordEvent("tool.result", {
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            name: call.tool,
            success: false,
            contentItems: protocolResponse.contentItems,
            rejectedAfterFinalSourceReply: true,
          });
          emitDynamicToolTerminalDiagnostic({
            response,
            call,
            agentId: sessionAgentId,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: 0,
          });
          embeddedAgentLog.warn("codex app-server rejected dynamic tool after final source reply", {
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            tool: call.tool,
          });
          return response;
        });
        // SAFETY: Codex dynamic-tool protocol responses contain only JSON-compatible fields.
        return toCodexDynamicToolProtocolResponse(await execution) as JsonValue;
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
          let response = await handleDynamicToolCallWithTimeout({
            call,
            toolBridge,
            signal,
            timeoutMs: dynamicToolTimeoutMs,
            toolMeta,
            toolCallOrdinal,
            onAgentToolResult: params.onAgentToolResult,
            observeToolTerminal: params.observeToolTerminal,
            onFinalSourceReplyDelivery: () => {
              commitFinalSourceReplyDelivery({
                call,
                durationMs: Math.max(0, Date.now() - toolStartedAt),
                requestAdmission,
              });
            },
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
          if (
            !response.success &&
            state.finalSourceReplyCommit?.call.callId === call.callId &&
            state.finalSourceReplyCommit.call.turnId === call.turnId
          ) {
            // The channel receipt predates optional result middleware. A later
            // presentation failure cannot make that irreversible send replayable.
            response = createCommittedFinalSourceReplyResponse({
              executedArguments: toolArgs ?? {},
            });
          }
          // A post-middleware confirmation still owns the same monotonic
          // boundary when the raw transport result was not independently enough.
          commitFinalSourceReply({
            call,
            response,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
            requestAdmission,
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
        if (response.terminate === true && response.success) {
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
      requestAdmission.release();
      if (requestCountsAsTurnActivity) {
        state.activeAppServerTurnRequests -= 1;
        noteProgress(`request:${request.method}:response`);
        scheduleTerminalDynamicToolReleaseCheck();
      }
    }
  };
  return { handleServerRequest };
}
