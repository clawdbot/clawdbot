import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import { copyChannelAgentToolMeta } from "../channel-tools.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../embedded-agent-runner/tool-schema-runtime.js";
import type { AgentTool } from "../runtime/index.js";
import {
  filterProviderNormalizableTools,
  type RuntimeToolSchemaDiagnostic,
} from "../tool-schema-projection.js";
import type { AgentRuntimePlan } from "./types.js";

type AgentRuntimeToolPolicyParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  runtimePlan?: AgentRuntimePlan;
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowProviderRuntimePluginLoad?: boolean;
  onPreNormalizationSchemaDiagnostics?: (
    diagnostics: readonly RuntimeToolSchemaDiagnostic[],
    tools: readonly AgentTool<TSchemaType, TResult>[],
  ) => void;
};

function runtimePlanToolContext(params: {
  workspaceDir?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
}) {
  return {
    workspaceDir: params.workspaceDir,
    modelApi: params.modelApi ?? undefined,
    model: params.model,
  };
}

function copyRuntimeToolMetadata(source: AgentTool, target: AgentTool): void {
  if (source === target) {
    return;
  }
  copyPluginToolMeta(source as never, target as never);
  copyChannelAgentToolMeta(source as never, target as never);
}

function preserveRuntimeToolMetadata<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  sourceTools: AgentTool<TSchemaType, TResult>[],
  normalizedTools: AgentTool<TSchemaType, TResult>[],
): AgentTool<TSchemaType, TResult>[] {
  const sourcesByUniqueName = new Map<string, AgentTool<TSchemaType, TResult>>();
  const duplicateNames = new Set<string>();
  for (const source of sourceTools) {
    const name = source.name;
    if (sourcesByUniqueName.has(name)) {
      duplicateNames.add(name);
      sourcesByUniqueName.delete(name);
      continue;
    }
    if (!duplicateNames.has(name)) {
      sourcesByUniqueName.set(name, source);
    }
  }
  for (const [index, target] of normalizedTools.entries()) {
    const indexedSource = sourceTools[index];
    const source =
      indexedSource?.name === target.name ? indexedSource : sourcesByUniqueName.get(target.name);
    if (source) {
      copyRuntimeToolMetadata(source, target);
    }
  }
  return normalizedTools;
}

export function normalizeAgentRuntimeTools<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: AgentRuntimeToolPolicyParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const planContext = runtimePlanToolContext(params);
  const normalizableToolProjection = filterProviderNormalizableTools(params.tools);
  if (normalizableToolProjection.diagnostics.length > 0) {
    params.onPreNormalizationSchemaDiagnostics?.(
      normalizableToolProjection.diagnostics,
      params.tools,
    );
  }
  const normalizableTools = [...normalizableToolProjection.tools] as AgentTool<
    TSchemaType,
    TResult
  >[];
  const normalized =
    params.runtimePlan?.tools.normalize(normalizableTools, planContext) ??
    normalizeProviderToolSchemas({
      tools: normalizableTools,
      provider: params.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env ?? process.env,
      modelId: params.modelId,
      modelApi: params.modelApi,
      model: params.model,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowProviderRuntimePluginLoad,
    });
  const normalizedTools = Array.isArray(normalized) ? normalized : normalizableTools;
  return preserveRuntimeToolMetadata(normalizableTools, normalizedTools);
}

export function logAgentRuntimeToolDiagnostics(params: AgentRuntimeToolPolicyParams): void {
  const planContext = runtimePlanToolContext(params);
  if (params.runtimePlan) {
    params.runtimePlan.tools.logDiagnostics(params.tools, planContext);
    return;
  }
  logProviderToolSchemaDiagnostics({
    tools: params.tools,
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    runtimeHandle: params.runtimeHandle,
  });
}
