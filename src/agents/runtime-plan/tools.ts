/**
 * Applies runtime-plan or provider fallback tool schema policy. The helpers
 * normalize tool schemas, preserve owner metadata across cloned definitions,
 * and emit provider diagnostics.
 */
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "../before-tool-call-metadata.js";
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
import { copyToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "../tools/common.js";
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
  /**
   * Invoked on every normalization, including with an empty list, so
   * consumers can observe the all-clear and retire stale quarantine state.
   */
  onPreNormalizationSchemaDiagnostics?: (
    diagnostics: readonly RuntimeToolSchemaDiagnostic[],
    tools: readonly AgentTool<TSchemaType, TResult>[],
  ) => void;
};

/** Builds the provider/runtime context passed into runtime-plan tool hooks. */
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

// Normalizers may return cloned tool definitions. Preserve owner and private
// execution metadata so downstream dispatch keeps the same policy and result contract.
function copyRuntimeToolMetadata(source: AgentTool, target: AgentTool): void {
  if (source === target) {
    return;
  }
  const catalogMode = (source as AnyAgentTool).catalogMode;
  if (catalogMode) {
    (target as AnyAgentTool).catalogMode = catalogMode;
  }
  if (source.outputSchema !== undefined) {
    target.outputSchema = source.outputSchema;
  }
  copyPluginToolMeta(source as never, target as never);
  copyChannelAgentToolMeta(source as never, target as never);
  copyBeforeToolCallHookMarker(source as never, target as never);
  copyToolTerminalPresentation(source as never, target as never);
}

// Duplicate names cannot be matched by map lookup alone, so same-index matches
// take precedence and unique-name fallback covers cloned arrays.
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

/** Normalizes tool schemas through a runtime plan or provider fallback policy. */
export function normalizeAgentRuntimeTools<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: AgentRuntimeToolPolicyParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const planContext = runtimePlanToolContext(params);
  const normalizableToolProjection = filterProviderNormalizableTools(params.tools);
  params.onPreNormalizationSchemaDiagnostics?.(
    normalizableToolProjection.diagnostics,
    params.tools,
  );
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

/** Emits runtime-plan or provider fallback diagnostics for normalized tools. */
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
