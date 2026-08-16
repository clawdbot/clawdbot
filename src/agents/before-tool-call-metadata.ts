import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BeforeToolCallDiagnosticOptions = {
  emitDiagnostics: boolean;
};

export const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
export const BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS = Symbol("beforeToolCallDiagnosticOptions");
export const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol("beforeToolCallSourceTool");
export const BEFORE_TOOL_CALL_HOOK_CONTEXT = Symbol("beforeToolCallHookContext");

type BeforeToolCallMetadataTool = AnyAgentTool & {
  [BEFORE_TOOL_CALL_WRAPPED]?: true;
  [BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS]?: BeforeToolCallDiagnosticOptions;
  [BEFORE_TOOL_CALL_SOURCE_TOOL]?: AnyAgentTool;
  [BEFORE_TOOL_CALL_HOOK_CONTEXT]?: HookContext;
};

function withBeforeToolCallMetadata(tool: AnyAgentTool): BeforeToolCallMetadataTool {
  return tool;
}

export function getBeforeToolCallSourceTool(tool: AnyAgentTool): AnyAgentTool | undefined {
  return withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_SOURCE_TOOL];
}

export function getBeforeToolCallHookContext(tool: AnyAgentTool): HookContext | undefined {
  return withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_HOOK_CONTEXT];
}

export function clearBeforeToolCallWrappedMarker(tool: AnyAgentTool): void {
  delete withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_WRAPPED];
}

/** Return true when a tool already carries the before_tool_call wrapper marker. */
export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  return withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_WRAPPED] === true;
}

/** Toggle diagnostic event emission on an existing before_tool_call wrapper. */
export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const options = withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_DIAGNOSTIC_OPTIONS];
  if (options) {
    options.emitDiagnostics = enabled;
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
  const sourceTool = getBeforeToolCallSourceTool(source);
  if (sourceTool) {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
  const hookContext = getBeforeToolCallHookContext(source);
  Object.defineProperty(target, BEFORE_TOOL_CALL_HOOK_CONTEXT, {
    value: hookContext,
    enumerable: false,
  });
}
