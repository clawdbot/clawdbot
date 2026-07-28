/**
 * Builds the operator-facing effective inventory for bundle MCP tools. Runtime
 * schema policy quarantines incompatible tools and emits notices instead of
 * silently hiding them.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import {
  disambiguateEffectiveToolLabels,
  resolveEffectiveToolLabel,
  resolveEffectiveToolRawDescription,
  summarizeEffectiveToolDescription,
} from "./tools-effective-inventory-shared.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

// Runtime schema diagnostics become operator-facing notices on the effective
// inventory screen instead of silently hiding quarantined MCP tools.
function buildMcpUnsupportedToolSchemaNotice(
  diagnostic: RuntimeToolSchemaDiagnostic,
): EffectiveToolInventoryNotice {
  return {
    id: `unsupported-tool-schema:${diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${diagnostic.toolName}" from plugin "${BUNDLE_MCP_PLUGIN_ID}" has an unsupported runtime input schema (${diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function buildMcpToolInventoryEntries(
  tools: readonly AnyAgentTool[],
): EffectiveToolInventoryEntry[] {
  return disambiguateEffectiveToolLabels(
    tools
      .map(
        (tool) =>
          ({
            id: tool.name,
            label: resolveEffectiveToolLabel(tool),
            description: summarizeEffectiveToolDescription(tool),
            rawDescription:
              resolveEffectiveToolRawDescription(tool) || summarizeEffectiveToolDescription(tool),
            source: "mcp",
            pluginId: BUNDLE_MCP_PLUGIN_ID,
          }) satisfies EffectiveToolInventoryEntry,
      )
      .toSorted((a, b) => a.label.localeCompare(b.label)),
    (entry) => entry.pluginId ?? entry.id,
  );
}

/** Builds the runtime-compatible MCP tool inventory and quarantine notices. */
export function buildRuntimeCompatibleMcpToolInventory(params: {
  tools: readonly AnyAgentTool[];
  cfg: OpenClawConfig;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string | null;
  runtimeModel?: ProviderRuntimeModel;
}): {
  entries: EffectiveToolInventoryEntry[];
  notices: EffectiveToolInventoryNotice[];
} {
  const preNormalizationProjection = filterProviderNormalizableTools(params.tools);
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [
    ...preNormalizationProjection.diagnostics,
  ];
  const normalizedTools = normalizeAgentRuntimeTools({
    tools: [...preNormalizationProjection.tools],
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
    allowProviderRuntimePluginLoad: false,
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  const projection = filterRuntimeCompatibleTools(normalizedTools);
  const diagnostics = [...preNormalizationDiagnostics, ...projection.diagnostics];
  return {
    entries: buildMcpToolInventoryEntries(projection.tools),
    notices: diagnostics.map(buildMcpUnsupportedToolSchemaNotice),
  };
}
