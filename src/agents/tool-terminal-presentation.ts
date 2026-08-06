/**
 * Internal opt-in for deterministic terminal summaries from trusted built-in tools.
 * This is intentionally absent from the public AgentTool and Plugin SDK contracts.
 */
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

type TerminalToolPresentation = { text: string };
type TerminalToolPresentationFormatter = (
  params: unknown,
  result: AgentToolResult<unknown>,
) => TerminalToolPresentation | undefined;

const terminalPresentationByTool = new WeakMap<object, TerminalToolPresentationFormatter>();

export function setToolTerminalPresentation<T extends AnyAgentTool>(
  tool: T,
  formatter: TerminalToolPresentationFormatter,
): T {
  terminalPresentationByTool.set(tool, formatter);
  return tool;
}

export function getToolTerminalPresentation(
  tool: AnyAgentTool,
): TerminalToolPresentationFormatter | undefined {
  return terminalPresentationByTool.get(tool);
}

export function copyToolTerminalPresentation(source: AnyAgentTool, target: AnyAgentTool): void {
  const formatter = terminalPresentationByTool.get(source);
  if (formatter) {
    terminalPresentationByTool.set(target, formatter);
  }
}
