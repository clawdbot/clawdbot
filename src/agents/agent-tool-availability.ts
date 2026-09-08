import { createToolExecutionMatcher } from "./tool-policy-shared.js";
import type { AnyAgentTool } from "./tools/common.js";

type ToolDefinition = Pick<AnyAgentTool, "name" | "parameters" | "description">;

export type AgentToolAvailabilityBinding = {
  prepare: (tool: ToolDefinition, callableTools: ReadonlyMap<string, ToolDefinition>) => void;
  executionSchema?: (schema: unknown) => unknown;
};

const availabilityBindings = new WeakMap<
  object,
  {
    binding: AgentToolAvailabilityBinding;
    executionDenied?: true;
  }
>();

export function bindAgentToolAvailability<T extends object>(
  tool: T,
  binding: AgentToolAvailabilityBinding,
): T {
  availabilityBindings.set(tool, { binding });
  return tool;
}

export function getAgentToolAvailabilityBinding(
  tool: object,
): AgentToolAvailabilityBinding | undefined {
  return availabilityBindings.get(tool)?.binding;
}

export function copyAgentToolAvailability<T extends object>(source: object, target: T): T {
  const metadata = availabilityBindings.get(source);
  if (metadata) {
    availabilityBindings.set(target, metadata);
  }
  return target;
}

/** Record an executor denial so later schema-only catalog projections cannot undo it. */
export function markAgentToolExecutionUnavailable<T extends object>(tool: T): T {
  const metadata = availabilityBindings.get(tool);
  if (metadata) {
    availabilityBindings.set(tool, { ...metadata, executionDenied: true });
  }
  return tool;
}

/** Finalize owner-controlled affordances after filtering; never rebind or grant tools. */
export function finalizeAgentToolAvailability<T extends ToolDefinition>(
  tools: readonly T[],
  options?: { toolExecutionAllow?: readonly string[]; onPrepared?: (tool: T) => void },
): T[] {
  // The caller supplies its winning definitions, including non-native shadows.
  // A missing, quarantined, or execution-denied dependency cannot enable a mode.
  const winners = new Map(tools.map((tool) => [tool.name, tool]));
  const executionAllowed = options?.toolExecutionAllow
    ? createToolExecutionMatcher(options.toolExecutionAllow)
    : undefined;
  const callableTools = new Map<string, T>();
  for (const callableTool of [...winners.values()].filter(
    (tool) =>
      !availabilityBindings.get(tool)?.executionDenied &&
      (!executionAllowed || executionAllowed(tool.name)),
  )) {
    callableTools.set(callableTool.name, callableTool);
  }
  for (const tool of tools) {
    const binding = availabilityBindings.get(tool)?.binding;
    if (binding) {
      binding.prepare(tool, callableTools);
      options?.onPrepared?.(tool);
    }
  }
  return [...tools];
}

export function resolveAgentToolExecutionSchema(tool: object, schema: unknown): unknown {
  return availabilityBindings.get(tool)?.binding.executionSchema?.(schema) ?? schema;
}
