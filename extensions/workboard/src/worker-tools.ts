import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

export function selectWorkboardTools(
  tools: AnyAgentTool[],
  names: ReadonlySet<string>,
  include: boolean,
): AnyAgentTool[] {
  return tools.filter((tool) => names.has(tool.name) === include);
}
