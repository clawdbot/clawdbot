/**
 * Projects failed-MCP-server diagnostics through the tool policy that admits
 * their tools. A server hidden by the capability profile or `tools.deny` must
 * stay invisible when it fails too: the model may not learn its name or its
 * connection text from an outage note it could never have used.
 */
import { Type } from "typebox";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import type { McpToolCatalogDiagnostic } from "../../agent-bundle-mcp-types.js";
import type { AnyAgentTool } from "../../tools/common.js";

// Stand-in tool name for a server that produced no tools; the policy decides on
// the plugin id and server metadata, never on this suffix.
const SERVER_PROBE_TOOL_NAME = "server";

function buildServerProbeTool(diagnostic: McpToolCatalogDiagnostic): AnyAgentTool {
  const probe: AnyAgentTool = {
    name: `${diagnostic.safeServerName}${TOOL_NAME_SEPARATOR}${SERVER_PROBE_TOOL_NAME}`,
    label: `${diagnostic.safeServerName} (MCP server policy probe)`,
    description: "",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      throw new Error("MCP server policy probe is never executed");
    },
  };
  setPluginToolMeta(probe, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: diagnostic.serverName,
      safeServerName: diagnostic.safeServerName,
      toolName: SERVER_PROBE_TOOL_NAME,
      operation: "tool",
    },
  });
  return probe;
}

/**
 * Keeps only the diagnostics whose server would still have tools after `admit`,
 * the exact filter chain the run applies to real bundle MCP tools.
 */
export function filterMcpDiagnosticsByToolPolicy(
  diagnostics: readonly McpToolCatalogDiagnostic[] | undefined,
  admit: (probes: AnyAgentTool[]) => readonly AnyAgentTool[],
): readonly McpToolCatalogDiagnostic[] | undefined {
  if (!diagnostics?.length) {
    return diagnostics;
  }
  const byProbe = new Map(
    diagnostics.map((diagnostic) => [buildServerProbeTool(diagnostic), diagnostic] as const),
  );
  const admitted = admit([...byProbe.keys()])
    .map((probe) => byProbe.get(probe))
    .filter((diagnostic): diagnostic is McpToolCatalogDiagnostic => diagnostic !== undefined);
  return admitted.length > 0 ? admitted : undefined;
}
