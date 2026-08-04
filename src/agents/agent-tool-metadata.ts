import { copyPluginToolMeta } from "../plugins/tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { copyCodeModeControlToolIdentity } from "./code-mode-control-tools.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

/** Preserve a live parameter-schema accessor across wrappers that spread a tool. */
export function copyAgentToolParameterAccessor<T extends AnyAgentTool>(
  source: AnyAgentTool,
  target: T,
): T {
  const sourceDescriptor = Object.getOwnPropertyDescriptor(source, "parameters");
  if (!sourceDescriptor?.get) {
    return target;
  }
  const targetDescriptor = Object.getOwnPropertyDescriptor(target, "parameters");
  if (targetDescriptor?.get || targetDescriptor?.set) {
    return target;
  }
  Object.defineProperty(target, "parameters", {
    configurable: true,
    enumerable: sourceDescriptor.enumerable,
    get: () => source.parameters,
  });
  return target;
}

/**
 * Preserve identity-backed tool metadata that object spread cannot carry.
 * Losing it detaches policy, hooks, presentation, and control-flow ownership.
 */
export function copyAgentToolMetadata<T extends AnyAgentTool>(source: AnyAgentTool, target: T): T {
  if (source === target) {
    return target;
  }
  copyPluginToolMeta(source, target);
  copyChannelAgentToolMeta(source as never, target as never);
  copyBeforeToolCallHookMarker(source, target);
  copyToolTerminalPresentation(source, target);
  copyCodeModeControlToolIdentity(source, target);
  return copyAgentToolParameterAccessor(source, target);
}
