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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  buildPluginToolMetadataKey,
  ensureStandalonePluginToolRegistryLoaded,
  getPluginToolMeta,
  resolvePluginTools,
} from "../../plugins/tools.js";
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
  risk?: "low" | "medium" | "high";
  tags?: string[];
  defaultProfiles: Array<"minimal" | "coding" | "messaging" | "full">;
};

type ToolCatalogGroup = {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolCatalogEntry[];
};

function resolveAgentIdOrRespondError(
  rawAgentId: unknown,
  respond: RespondFn,
  cfg: OpenClawConfig,
) {
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
  const toolContext = {
    config: params.cfg,
    workspaceDir,
    agentDir,
    agentId: params.agentId,
  };
  ensureStandalonePluginToolRegistryLoaded({
    context: toolContext,
    toolAllowlist: ["group:plugins"],
    allowGatewaySubagentBinding: true,
  });
  const pluginTools = resolvePluginTools({
    context: toolContext,
    existingToolNames: params.existingToolNames,
    toolAllowlist: ["group:plugins"],
    suppressNameConflicts: true,
    allowGatewaySubagentBinding: true,
  });
  const activeRegistry = getActivePluginRegistry();
  const groups = new Map<string, ToolCatalogGroup>();
  // Key metadata by plugin ownership and tool name so we only project metadata that
  // was registered BY the tool's owning plugin. Without this scoping, plugin-X
  // could override the catalog label/description/risk/tags for another plugin's
  // tool by registering metadata with the same toolName.
  const pluginToolMetadata = new Map(
    (activeRegistry?.toolMetadata ?? []).map((entry) => [
      buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName),
      entry.metadata,
    ]),
  );
  const seenToolIds = new Set<string>();
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
    const ownedMetadata = meta?.pluginId
      ? pluginToolMetadata.get(buildPluginToolMetadataKey(meta.pluginId, tool.name))
      : undefined;
    existing.tools.push({
      id: tool.name,
      label:
        normalizeOptionalString(ownedMetadata?.displayName) ??
        normalizeOptionalString(tool.label) ??
        tool.name,
      description: summarizeToolDescriptionText({
        rawDescription:
          ownedMetadata?.description ??
          (typeof tool.description === "string" ? tool.description : undefined),
        displaySummary: tool.displaySummary,
      }),
      source: "plugin",
      pluginId,
      optional: meta?.optional,
      risk: ownedMetadata?.risk,
      tags: ownedMetadata?.tags,
      defaultProfiles: [],
    });
    seenToolIds.add(tool.name);
    groups.set(groupId, existing);
  }
  for (const entry of activeRegistry?.tools ?? []) {
    const names = entry.names.length > 0 ? entry.names : (entry.declaredNames ?? []);
    for (const name of names) {
      if (seenToolIds.has(name) || params.existingToolNames.has(name)) {
        continue;
      }
      const groupId = `plugin:${entry.pluginId}`;
      const existing =
        groups.get(groupId) ??
        ({
          id: groupId,
          label: entry.pluginName ?? entry.pluginId,
          source: "plugin",
          pluginId: entry.pluginId,
          tools: [],
        } as ToolCatalogGroup);
      const ownedMetadata = pluginToolMetadata.get(
        buildPluginToolMetadataKey(entry.pluginId, name),
      );
      existing.tools.push({
        id: name,
        label: normalizeOptionalString(ownedMetadata?.displayName) ?? name,
        description:
          summarizeToolDescriptionText({
            rawDescription: ownedMetadata?.description,
          }) || `Plugin tool from ${entry.pluginName ?? entry.pluginId}`,
        source: "plugin",
        pluginId: entry.pluginId,
        optional: entry.optional,
        risk: ownedMetadata?.risk,
        tags: ownedMetadata?.tags,
        defaultProfiles: [],
      });
      seenToolIds.add(name);
      groups.set(groupId, existing);
    }
  }
  return [...groups.values()]
    .map((group) =>
      Object.assign({}, group, { tools: group.tools.toSorted((a, b) => a.id.localeCompare(b.id)) }),
    )
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
  "tools.catalog": ({ params, respond, context }) => {
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
    const resolved = resolveAgentIdOrRespondError(
      params.agentId,
      respond,
      context.getRuntimeConfig(),
    );
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
