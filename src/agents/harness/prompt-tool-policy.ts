import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import {
  buildBundleMcpPolicyLayers,
  createBundleMcpServerPolicyMatcher,
} from "../embedded-agent-runner/effective-tool-policy.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../tool-search-types.js";
import {
  restrictToolSearchCatalog,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
} from "../tool-search.js";
import type { AnyAgentTool } from "../tools/common.js";

type NamedTool = { name: string };

function isAgentTool(tool: NamedTool): tool is AnyAgentTool {
  return "execute" in tool && typeof tool.execute === "function";
}

function filterTools<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow?: string[],
  toolMeta: (tool: T) => { pluginId: string } | undefined = (tool) =>
    isAgentTool(tool) ? getPluginToolMeta(tool) : undefined,
): T[] {
  return toolsAllow === undefined
    ? [...tools]
    : applyEmbeddedAttemptToolsAllow([...tools], toolsAllow, { toolMeta });
}

export function createAgentHarnessPromptToolPolicy<T extends NamedTool>(params: {
  tools: readonly T[];
  catalogRef?: ToolSearchCatalogRef;
  catalogEntries?: readonly ToolSearchCatalogEntry[];
  codeModeControlsEnabled: boolean;
}) {
  const baselineTools = [...params.tools];
  const currentCatalog = params.catalogRef?.current;
  const catalog =
    currentCatalog && params.catalogRef
      ? {
          ref: params.catalogRef,
          entries: [...(params.catalogEntries ?? currentCatalog.entries)],
          mcpDiagnostics: currentCatalog.mcpDiagnostics ?? { diagnostics: [], policyLayers: [] },
          controlNames: params.codeModeControlsEnabled
            ? new Set([CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME])
            : TOOL_SEARCH_CONTROL_TOOL_NAMES,
        }
      : undefined;
  return {
    apply: (input: { toolsAllow?: string[]; forceToolNames?: readonly string[] } = {}) => {
      const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(input.toolsAllow, {
        forceToolNames: input.forceToolNames,
      });
      const allowedTools = filterTools(baselineTools, toolsAllow);
      if (!catalog) {
        const executableTools: AnyAgentTool[] = [];
        for (const tool of allowedTools) {
          if (isAgentTool(tool)) {
            executableTools.push(tool);
          }
        }
        finalizeAgentToolAvailability(executableTools);
        return {
          tools: allowedTools,
          callableToolNames: normalizeUniqueStringEntries(allowedTools.map((tool) => tool.name)),
        };
      }
      const allowedEntries = filterTools(catalog.entries, toolsAllow, (entry) =>
        isAgentTool(entry.tool) ? getPluginToolMeta(entry.tool) : undefined,
      );
      // A failed server has no entry for the allowlist to keep or drop, so its
      // outage note is judged by server namespace. The run's layers are judged
      // with this hook's cap in one decision: each alone can admit a different
      // tool of the server while no tool satisfies the layers together.
      const admitsMcpServer = createBundleMcpServerPolicyMatcher([
        ...catalog.mcpDiagnostics.policyLayers,
        ...buildBundleMcpPolicyLayers({ toolsAllow }),
      ]);
      const catalogCount = restrictToolSearchCatalog({
        catalogRef: catalog.ref,
        allowedToolNames: new Set(allowedEntries.map((entry) => entry.name)),
        baselineEntries: catalog.entries,
        mcpDiagnostics: {
          ...catalog.mcpDiagnostics,
          diagnostics: catalog.mcpDiagnostics.diagnostics.filter((diagnostic) =>
            admitsMcpServer(diagnostic.safeServerName),
          ),
        },
      });
      const allowedNames = new Set(allowedTools.map((tool) => normalizeToolPolicyName(tool.name)));
      const tools = baselineTools.filter((tool) => {
        const name = normalizeToolPolicyName(tool.name);
        return allowedNames.has(name) || (catalogCount > 0 && catalog.controlNames.has(name));
      });
      const catalogReachable =
        catalogCount > 0 &&
        tools.some((tool) => catalog.controlNames.has(normalizeToolPolicyName(tool.name)));
      return {
        tools,
        callableToolNames: normalizeUniqueStringEntries([
          ...tools.map((tool) => tool.name),
          ...(catalogReachable ? allowedEntries.map((entry) => entry.name) : []),
        ]),
      };
    },
  };
}
