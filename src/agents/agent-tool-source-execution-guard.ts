import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const sourceExecutionGuards = new WeakMap<AnyAgentTool, () => void>();

/** Bind a host-owned guard without mutating a tool that another attempt may reuse. */
export function bindAgentToolSourceExecutionGuard(
  tool: AnyAgentTool,
  guard: () => void,
): AnyAgentTool {
  const bound = copyAgentToolMetadata(tool, { ...tool });
  sourceExecutionGuards.set(bound, guard);
  return bound;
}

export function copyAgentToolSourceExecutionGuard(
  source: AnyAgentTool,
  target: AnyAgentTool,
): void {
  const guard = sourceExecutionGuards.get(source);
  if (guard) {
    sourceExecutionGuards.set(target, guard);
  }
}

export function runAgentToolSourceExecutionGuard(tool: AnyAgentTool): void {
  sourceExecutionGuards.get(tool)?.();
}
