import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

/** Project one OpenClaw dynamic-tool response with its executed mutation identity. */
export function recordCodexDynamicToolResult(
  projector: CodexAppServerEventProjector | undefined,
  call: CodexDynamicToolCallParams,
  response: CodexDynamicToolRuntimeResponse,
  protocolResponse: CodexDynamicToolCallResponse,
): void {
  projector?.recordDynamicToolResult({
    callId: call.callId,
    tool: call.tool,
    asyncStarted: response.asyncStarted === true,
    terminalResolution: response.terminalResolution,
    success: protocolResponse.success,
    terminalType:
      response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
    sideEffectEvidence:
      response.sideEffectEvidence === true ||
      response.terminalResolution?.sideEffectEvidence === true,
    contentItems: protocolResponse.contentItems,
    details: response.transcriptDetails,
  });
}
