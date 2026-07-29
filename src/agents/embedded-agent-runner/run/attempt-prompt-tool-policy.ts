import { getPluginToolMeta } from "../../../plugins/tools.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import type { AgentSession } from "../../sessions/index.js";
import { normalizeToolName } from "../../tool-policy.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import {
  restrictToolSearchCatalog,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
} from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "./attempt-tool-construction-plan.js";

type NamedTool = { name: string };
type PromptToolSession = Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">;

type PromptBuildToolPolicyBaseline = {
  activeToolNames: readonly string[];
  catalogEntries: readonly ToolSearchCatalogEntry[];
};

function filterTools<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow: string[],
  toolMeta: (tool: T) => { pluginId: string } | undefined = (tool) =>
    getPluginToolMeta(tool as unknown as AnyAgentTool),
): T[] {
  return applyEmbeddedAttemptToolsAllow([...tools], toolsAllow, {
    toolMeta,
  });
}

function applyToolsAllow<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow: string[] | undefined,
  toolMeta?: (tool: T) => { pluginId: string } | undefined,
): T[] {
  return toolsAllow === undefined ? [...tools] : filterTools(tools, toolsAllow, toolMeta);
}

function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Applies a prompt-hook tool cap to the already-built turn surface. Filtering
 * the concrete host baseline makes the hook an intersection with every host
 * policy while allowing a later prompt build to apply a different cap.
 */
export function applyPromptBuildToolsAllow<
  TEffectiveTool extends NamedTool,
  TUncompactedTool extends NamedTool,
  TTool extends NamedTool,
>(params: {
  session: PromptToolSession;
  toolsAllow?: string[];
  baseline: PromptBuildToolPolicyBaseline;
  effectiveTools: TEffectiveTool[];
  uncompactedEffectiveTools: TUncompactedTool[];
  tools: TTool[];
  catalogRef?: ToolSearchCatalogRef;
  codeModeControlsEnabled: boolean;
  forceToolNames?: readonly string[];
}): {
  activeToolNames: string[];
  effectiveTools: TEffectiveTool[];
  uncompactedEffectiveTools: TUncompactedTool[];
  tools: TTool[];
} {
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceToolNames: params.forceToolNames,
  });
  const allowedCatalogEntries = applyToolsAllow<ToolSearchCatalogEntry>(
    params.baseline.catalogEntries,
    toolsAllow,
    (entry) => getPluginToolMeta(entry.tool as AnyAgentTool),
  );
  const catalogToolCount = restrictToolSearchCatalog({
    catalogRef: params.catalogRef,
    allowedToolNames: new Set(allowedCatalogEntries.map((entry) => entry.name)),
    baselineEntries: params.baseline.catalogEntries,
  });
  const allowedEffectiveTools = applyToolsAllow(params.effectiveTools, toolsAllow);
  const allowedUncompactedTools = applyToolsAllow(params.uncompactedEffectiveTools, toolsAllow);
  const allowedTools = applyToolsAllow(params.tools, toolsAllow);
  const allowedActiveNames = new Set(
    applyToolsAllow(
      params.baseline.activeToolNames.map((name) => ({ name })),
      toolsAllow,
    ).map((tool) => normalizeToolName(tool.name)),
  );
  for (const tool of [...allowedEffectiveTools, ...allowedUncompactedTools, ...allowedTools]) {
    allowedActiveNames.add(normalizeToolName(tool.name));
  }

  const catalogControlNames = params.codeModeControlsEnabled
    ? new Set([CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME])
    : TOOL_SEARCH_CONTROL_TOOL_NAMES;
  const keepVisibleTool = (tool: NamedTool) => {
    const normalized = normalizeToolName(tool.name);
    return (
      allowedActiveNames.has(normalized) ||
      (catalogToolCount > 0 && catalogControlNames.has(normalized))
    );
  };
  const effectiveTools = params.effectiveTools.filter(keepVisibleTool);
  const activeToolNames = params.baseline.activeToolNames.filter((name) =>
    keepVisibleTool({ name }),
  );
  if (!sameToolNames(params.session.getActiveToolNames(), activeToolNames)) {
    params.session.setActiveToolsByName(activeToolNames);
  }

  return {
    activeToolNames,
    effectiveTools,
    uncompactedEffectiveTools: allowedUncompactedTools,
    tools: allowedTools,
  };
}
