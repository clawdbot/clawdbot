import {
  finalizeAgentToolAvailability,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectCodexDynamicTools,
  type CodexDynamicToolSchemaQuarantine,
  type ProjectedCodexDynamicTool,
} from "./dynamic-tool-catalog.js";

/** Prepare the actual executable set, then reproject only changed owner definitions. */
export function finalizeCodexToolAvailability(
  entries: readonly ProjectedCodexDynamicTool<AnyAgentTool>[],
) {
  const snapshots = entries.map((entry) => ({
    entry,
    parameters: entry.tool.parameters,
    description: entry.tool.description,
  }));
  const preparedNames = new Set<string>();
  finalizeAgentToolAvailability(
    entries.map((entry) => entry.tool),
    {
      onPrepared: (tool) => preparedNames.add(tool.name),
    },
  );
  const tools: ProjectedCodexDynamicTool<AnyAgentTool>[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  for (const { entry, parameters, description } of snapshots) {
    if (entry.tool.parameters === parameters && entry.tool.description === description) {
      tools.push(entry);
      continue;
    }
    const projected = projectCodexDynamicTools([entry.tool]);
    tools.push(...projected.tools);
    quarantinedTools.push(...projected.quarantinedTools);
  }
  return { tools, quarantinedTools, preparedNames };
}
