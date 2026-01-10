import type { AgentTool } from "@mariozechner/pi-agent-core";

export function buildToolSummaryMap(
  tools: AgentTool[],
): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const tool of tools) {
    const summary = tool.description?.trim() || tool.label?.trim();
    if (!summary) continue;
    summaries[tool.name.toLowerCase()] = summary;
  }
  return summaries;
}
