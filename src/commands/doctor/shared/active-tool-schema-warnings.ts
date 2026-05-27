import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { parseModelRef } from "../../../agents/model-selection-normalize.js";
import { createOpenClawCodingTools } from "../../../agents/pi-tools.js";
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
    let tools: ReturnType<typeof createOpenClawCodingTools>;
    try {
      tools = createOpenClawCodingTools({
        agentId,
        agentDir: resolveAgentDir(params.cfg, agentId, env),
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, env),
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

    const projection = filterRuntimeCompatibleTools(tools);
    for (const diagnostic of projection.diagnostics) {
      const tool = tools[diagnostic.toolIndex];
      warnings.push(
        formatDiagnostic({
          agentId,
          diagnostic,
          ...(tool ? { pluginId: getPluginToolMeta(tool)?.pluginId } : {}),
        }),
      );
    }
  }

  return warnings;
}
