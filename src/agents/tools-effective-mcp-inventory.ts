import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

function resolveMcpToolLabel(tool: AnyAgentTool): string {
  const rawLabel = normalizeOptionalString(tool.label) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function resolveRawToolDescription(tool: AnyAgentTool): string {
  return normalizeOptionalString(tool.description) ?? "";
}

function summarizeToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    rawDescription: resolveRawToolDescription(tool),
    displaySummary: tool.displaySummary,
  });
}

function buildMcpUnsupportedToolSchemaNotice(
  diagnostic: RuntimeToolSchemaDiagnostic,
): EffectiveToolInventoryNotice {
  return {
    id: `unsupported-tool-schema:${diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${diagnostic.toolName}" from plugin "${BUNDLE_MCP_PLUGIN_ID}" has an unsupported runtime input schema (${diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function disambiguateLabels(entries: EffectiveToolInventoryEntry[]): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    return { ...entry, label: `${entry.label} (${entry.pluginId ?? entry.id})` };
  });
}

function buildMcpToolInventoryEntries(
  tools: readonly AnyAgentTool[],
): EffectiveToolInventoryEntry[] {
  return disambiguateLabels(
    tools
      .map((tool) => ({
        id: tool.name,
        label: resolveMcpToolLabel(tool),
        description: summarizeToolDescription(tool),
        rawDescription: resolveRawToolDescription(tool) || summarizeToolDescription(tool),
        source: "mcp",
        pluginId: BUNDLE_MCP_PLUGIN_ID,
      }) satisfies EffectiveToolInventoryEntry)
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
}

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
  const normalizedTools = normalizeAgentRuntimeTools({
    tools: [...params.tools],
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
    allowProviderRuntimePluginLoad: false,
  });
  const projection = filterRuntimeCompatibleTools(normalizedTools);
  return {
    entries: buildMcpToolInventoryEntries(projection.tools),
    notices: projection.diagnostics.map(buildMcpUnsupportedToolSchemaNotice),
  };
}
