import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import { createOpenClawCodingTools } from "../agents/pi-tools.js";
import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import { inspectRuntimeToolInputSchemas } from "../agents/tool-schema-projection.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { HealthFinding } from "./health-checks.js";

export function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

function buildDoctorRuntimeModel(params: {
  entry?: ModelCatalogEntry;
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  const provider = params.provider || DEFAULT_PROVIDER;
  const id = params.modelId || DEFAULT_MODEL;
  const api =
    provider === "openai-codex"
      ? "openai-codex-responses"
      : provider === "openai"
        ? "openai-responses"
        : undefined;
  const baseUrl =
    provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : provider === "openai"
        ? "https://api.openai.com/v1"
        : undefined;
  return {
    ...params.entry,
    provider,
    id,
    name: params.entry?.name ?? id,
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  } as ProviderRuntimeModel;
}

export async function collectRuntimeToolSchemaFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const modelRef = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: true,
  });
  const catalog = await loadModelCatalog({ config: cfg });
  const model = buildDoctorRuntimeModel({
    entry: findModelInCatalog(catalog, modelRef.provider, modelRef.model),
    provider: modelRef.provider,
    modelId: modelRef.model,
  });
  if (!supportsModelTools(model)) {
    return [];
  }
  const tools = createOpenClawCodingTools({
    agentId,
    workspaceDir,
    config: cfg,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
    modelApi: model.api,
    modelCompat: model.compat,
    modelContextWindowTokens: model.contextWindow,
    allowGatewaySubagentBinding: true,
    emitBeforeToolCallDiagnostics: false,
  });
  const normalizedTools = normalizeAgentRuntimeTools({
    tools,
    provider: modelRef.provider,
    config: cfg,
    workspaceDir,
    env: process.env,
    modelId: modelRef.model,
    modelApi: model.api,
    model,
  });
  return inspectRuntimeToolInputSchemas(normalizedTools).map((diagnostic) => {
    const tool = normalizedTools[diagnostic.toolIndex];
    const pluginId = tool ? getPluginToolMeta(tool)?.pluginId : undefined;
    const owner = pluginId ? ` from plugin ${pluginId}` : "";
    return {
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message: `Tool ${diagnostic.toolName}${owner} has an unsupported input schema for runtime projection.`,
      path: pluginId ? `plugins.entries.${pluginId}` : `tools.${diagnostic.toolName}`,
      target: diagnostic.toolName,
      requirement: diagnostic.violations.join(", "),
      fixHint:
        "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
    } satisfies HealthFinding;
  });
}
