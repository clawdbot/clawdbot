import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  listCoreToolSections,
  PROFILE_OPTIONS,
  resolveCoreToolProfiles,
} from "../../agents/tool-catalog.js";
import { summarizeToolDescriptionText } from "../../agents/tool-description-summary.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginToolMeta, resolvePluginTools } from "../../plugins/tools.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ToolsCatalogResult,
  validateToolsCatalogParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type ToolCatalogEntry = {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
  defaultProfiles: Array<"minimal" | "coding" | "messaging" | "full">;
};

type ToolCatalogGroup = {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolCatalogEntry[];
};

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = normalizeOptionalString(rawAgentId) ?? "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId };
}

function buildCoreGroups(): ToolCatalogGroup[] {
  return listCoreToolSections().map((section) => ({
    id: section.id,
    label: section.label,
    source: "core",
    tools: section.tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
      source: "core",
      defaultProfiles: resolveCoreToolProfiles(tool.id),
    })),
  }));
}

function buildPluginGroups(params: {
  cfg: OpenClawConfig;
  agentId: string;
  existingToolNames: Set<string>;
}): ToolCatalogGroup[] {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const pluginTools = resolvePluginTools({
    context: {
      config: params.cfg,
      workspaceDir,
      agentDir,
      agentId: params.agentId,
    },
    existingToolNames: params.existingToolNames,
    toolAllowlist: ["group:plugins"],
    suppressNameConflicts: true,
    allowGatewaySubagentBinding: true,
  });
  const groups = new Map<string, ToolCatalogGroup>();
  for (const tool of pluginTools) {
    const meta = getPluginToolMeta(tool);
    const pluginId = meta?.pluginId ?? "plugin";
    const groupId = `plugin:${pluginId}`;
    const existing =
      groups.get(groupId) ??
      ({
        id: groupId,
        label: pluginId,
        source: "plugin",
        pluginId,
        tools: [],
      } as ToolCatalogGroup);
    existing.tools.push({
      id: tool.name,
      label: normalizeOptionalString(tool.label) ?? tool.name,
      description: summarizeToolDescriptionText({
        rawDescription: typeof tool.description === "string" ? tool.description : undefined,
        displaySummary: tool.displaySummary,
      }),
      source: "plugin",
      pluginId,
      optional: meta?.optional,
      defaultProfiles: [],
    });
    groups.set(groupId, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function buildToolsCatalogResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  includePlugins?: boolean;
}): ToolsCatalogResult {
  const agentId = normalizeOptionalString(params.agentId) || resolveDefaultAgentId(params.cfg);
  const includePlugins = params.includePlugins !== false;
  const groups = buildCoreGroups();
  if (includePlugins) {
    const existingToolNames = new Set(
      groups.flatMap((group) => group.tools.map((tool) => tool.id)),
    );
    groups.push(
      ...buildPluginGroups({
        cfg: params.cfg,
        agentId,
        existingToolNames,
      }),
    );
  }
  return {
    agentId,
    profiles: PROFILE_OPTIONS.map((profile) => ({ id: profile.id, label: profile.label })),
    groups,
  };
}

export const toolsCatalogHandlers: GatewayRequestHandlers = {
  "tools.catalog": ({ params, respond }) => {
    if (!validateToolsCatalogParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.catalog params: ${formatValidationErrors(validateToolsCatalogParams.errors)}`,
        ),
      );
      return;
    }
    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    respond(
      true,
      buildToolsCatalogResult({
        cfg: resolved.cfg,
        agentId: resolved.agentId,
        includePlugins: params.includePlugins,
      }),
      undefined,
    );
  },
};
