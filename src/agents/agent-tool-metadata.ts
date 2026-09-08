import { copyPluginToolMeta, getPluginToolMeta } from "../plugins/tool-metadata.js";
import { copyAgentToolAvailability } from "./agent-tool-availability.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { copyCodeModeControlToolIdentity } from "./code-mode-control-tools.js";
import { copyCronScheduledToolProjection } from "./exec-tool-target-pinning.js";
import { copyInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

export type AgentToolActionDescriptor = Readonly<{
  family: "data" | "tool";
  operation: "filesystem" | "memory" | "openclaw" | "process";
}>;

const actionDescriptors = new WeakMap<AnyAgentTool, AgentToolActionDescriptor>();

export function bindAgentToolActionDescriptor(
  tool: AnyAgentTool,
  descriptor: AgentToolActionDescriptor,
): void {
  actionDescriptors.set(tool, descriptor);
}

export function getAgentToolActionDescriptor(
  tool: AnyAgentTool,
): AgentToolActionDescriptor | undefined {
  return actionDescriptors.get(tool);
}

function copyAgentToolActionDescriptor(source: AnyAgentTool, target: AnyAgentTool): void {
  const descriptor = actionDescriptors.get(source);
  if (descriptor) {
    actionDescriptors.set(target, descriptor);
  }
}

/** Preserve only the metadata owned by a before-tool-call wrapper rebuild. */
export function copyBeforeToolCallWrapperMetadata(
  source: AnyAgentTool,
  target: AnyAgentTool,
): void {
  copyPluginToolMeta(source, target);
  // SAFETY: both metadata owners attach to the same runtime tool object shape.
  copyChannelAgentToolMeta(source as never, target as never);
  copyToolTerminalPresentation(source, target);
  copyAgentToolActionDescriptor(source, target);
  copyAgentToolAvailability(source, target);
}

/** Bind the broad family at final assembly from private, process-stable owner metadata. */
export function bindAssembledAgentToolActionDescriptor(tool: AnyAgentTool): void {
  if (actionDescriptors.has(tool)) {
    return;
  }
  const kind = getPluginToolMeta(tool)?.kind;
  const memory = kind === "memory" || (Array.isArray(kind) && kind.includes("memory"));
  actionDescriptors.set(
    tool,
    memory ? { family: "data", operation: "memory" } : { family: "tool", operation: "openclaw" },
  );
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
  copyCronScheduledToolProjection(source, target);
  copyInternalToolExecutionPreparer(source, target);
  copyAgentToolActionDescriptor(source, target);
  copyAgentToolAvailability(source, target);
  return target;
}
