/**
 * Public facade for before_tool_call policy and execution handling.
 *
 * Implementation is split by ownership: approval transport, ordered policy
 * orchestration, diagnostics/telemetry, and wrapped execution/finalization.
 */
export type {
  BeforeToolCallFailureDisposition,
  BeforeToolCallPolicyDiagnosticState,
  DeferredPluginToolApproval,
  HookContext,
  ToolOutcomeObservation,
  ToolOutcomeObserver,
} from "./agent-tools.before-tool-call.types.js";
export {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  peekAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.state.js";
export {
  copyBeforeToolCallHookMarker,
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
} from "./before-tool-call-metadata.js";
export { finalizeToolTerminalPresentation } from "./agent-tools.before-tool-call.diagnostics.js";
export {
  cancelDeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
} from "./agent-tools.before-tool-call.approval.js";
export {
  getBeforeToolCallPolicyDiagnosticState,
  hasBeforeToolCallPolicy,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.policy.js";
export {
  buildBlockedToolResult,
  getBeforeToolCallFailureDisposition,
  isBeforeToolCallBlockedError,
  isPreExecutionBlockedToolResult,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
