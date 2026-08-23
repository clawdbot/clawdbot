import type { AnyAgentTool } from "./tools/common.js";

export type BeforeToolCallDiagnosticOptions = {
  emitDiagnostics: boolean;
};

export const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
export const BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS = Symbol("beforeToolCallDiagnosticOptions");
export const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol("beforeToolCallSourceTool");
export const BEFORE_TOOL_CALL_HOOK_CONTEXT = Symbol("beforeToolCallHookContext");

/** Return true when a tool already carries the before_tool_call wrapper marker. */
export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

/** Toggle diagnostic event emission on an existing before_tool_call wrapper. */
export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  const options = taggedTool[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS];
  if (options && typeof options === "object" && "emitDiagnostics" in options) {
    (options as BeforeToolCallDiagnosticOptions).emitDiagnostics = enabled;
  }
}

/** Copy before_tool_call marker metadata when another wrapper replaces a tool. */
export function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void {
  if (!isToolWrappedWithBeforeToolCallHook(source)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  const taggedSource = source as unknown as Record<symbol, unknown>;
  const sourceTool = taggedSource[BEFORE_TOOL_CALL_SOURCE_TOOL];
  if (sourceTool && typeof sourceTool === "object") {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
  const hookContext = taggedSource[BEFORE_TOOL_CALL_HOOK_CONTEXT];
  Object.defineProperty(target, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: hookContext,
    enumerable: false,
  });
}
