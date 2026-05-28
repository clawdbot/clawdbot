import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../../../agents/agent-tools.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { parseModelRef } from "../../../agents/model-selection-normalize.js";
import { normalizeAgentRuntimeTools } from "../../../agents/runtime-plan/tools.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "../../../agents/tool-schema-projection.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";

function resolvePrimaryModelRef(
  cfg: OpenClawConfig,
  agentModel?: NonNullable<ReturnType<typeof resolveAgentConfig>>["model"],
): { provider: string; model: string } {
  const raw =
    resolveAgentModelPrimaryValue(agentModel) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return (
    parseModelRef(raw, DEFAULT_PROVIDER, { allowPluginNormalization: false }) ?? {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    }
  );
}

function formatDiagnostic(params: {
  agentId: string;
  diagnostic: RuntimeToolSchemaDiagnostic;
  pluginId?: string;
}): string {
  const plugin = params.pluginId ? ` from plugin "${params.pluginId}"` : "";
  return sanitizeForLog(
    `- agents.${params.agentId}: active tool "${params.diagnostic.toolName}"${plugin} has unsupported runtime input schema (${params.diagnostic.violations.join(", ")}). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.`,
  );
}

export function collectActiveToolSchemaProjectionWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (params.cfg.plugins?.enabled === false) {
    return [];
  }

  const env = params.env ?? process.env;
  const warnings: string[] = [];
  for (const agentId of listAgentIds(params.cfg)) {
    const agentConfig = resolveAgentConfig(params.cfg, agentId);
    const modelRef = resolvePrimaryModelRef(params.cfg, agentConfig?.model);
    const agentDir = resolveAgentDir(params.cfg, agentId, env);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId, env);
    let tools: ReturnType<typeof createOpenClawCodingTools>;
    try {
      tools = createOpenClawCodingTools({
        agentId,
        agentDir,
        workspaceDir,
        config: params.cfg,
        modelProvider: modelRef.provider,
        modelId: modelRef.model,
        allowGatewaySubagentBinding: true,
      });
    } catch (error) {
      warnings.push(
        sanitizeForLog(
          `- agents.${agentId}: active tool schema validation could not load the runtime tool set (${formatErrorMessage(error)}). Fix plugin loading errors before relying on assistant tool startup.`,
        ),
      );
      continue;
    }

    const rawToolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    let normalizedTools: typeof tools;
    try {
      normalizedTools = normalizeAgentRuntimeTools({
        tools,
        provider: modelRef.provider,
        config: params.cfg,
        workspaceDir,
        env,
        modelId: modelRef.model,
      });
    } catch (error) {
      warnings.push(
        sanitizeForLog(
          `- agents.${agentId}: active tool schema validation could not normalize the runtime tool set (${formatErrorMessage(error)}). Fix provider/plugin loading errors before relying on assistant tool startup.`,
        ),
      );
      continue;
    }
    const projection = filterRuntimeCompatibleTools(normalizedTools);
    for (const diagnostic of projection.diagnostics) {
      const tool = normalizedTools[diagnostic.toolIndex];
      const rawTool = rawToolsByName.get(diagnostic.toolName);
      const pluginId =
        (tool ? getPluginToolMeta(tool)?.pluginId : undefined) ??
        (rawTool ? getPluginToolMeta(rawTool)?.pluginId : undefined);
      warnings.push(
        formatDiagnostic({
          agentId,
          diagnostic,
          ...(pluginId ? { pluginId } : {}),
        }),
      );
    }
  }

  return warnings;
}
