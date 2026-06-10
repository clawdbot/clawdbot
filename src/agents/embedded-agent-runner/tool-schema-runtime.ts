/**
 * Normalizes and logs provider-specific tool schemas at runtime.
 */
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PluginLruCache, createPluginCacheKey } from "../../plugins/plugin-cache-primitives.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin,
  resolveProviderToolSchemaNormalizeCacheKey,
} from "../../plugins/provider-runtime.js";
import type { ProviderToolSchemaDiagnostic } from "../../plugins/types.js";
import type { AgentTool } from "../runtime/index.js";
import type { AnyAgentTool } from "../tools/common.js";
import { log } from "./logger.js";

type ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowRuntimePluginLoad?: boolean;
};

type CachedProviderToolSchemaBundle = {
  parametersByTool: Array<{
    name: string;
    parameters: unknown;
  }>;
};

type ProviderToolSchemaCacheStats = {
  bypass: number;
  hit: number;
  miss: number;
  store: number;
};

const PROVIDER_TOOL_SCHEMA_CACHE_VERSION = 1;
const providerToolSchemaCache = new PluginLruCache<CachedProviderToolSchemaBundle>(128);
const providerToolSchemaCacheStats: ProviderToolSchemaCacheStats = {
  bypass: 0,
  hit: 0,
  miss: 0,
  store: 0,
};

function buildProviderToolSchemaContext<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  params: ProviderToolSchemaParams<TSchemaType, TResult>,
  provider: string,
) {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    tools: params.tools as unknown as AnyAgentTool[],
  };
}

function normalizeCacheString(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(stableJsonValue(value)) ?? "undefined";
}

function cloneSchemaValue(value: unknown): unknown {
  return structuredClone(value);
}

function cloneToolParametersForCache(tools: AgentTool[]): CachedProviderToolSchemaBundle | null {
  try {
    return {
      parametersByTool: tools.map((tool) => ({
        name: tool.name,
        parameters: cloneSchemaValue(tool.parameters),
      })),
    };
  } catch {
    return null;
  }
}

function applyCachedToolParameters<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  tools: AgentTool<TSchemaType, TResult>[],
  cached: CachedProviderToolSchemaBundle,
): AgentTool<TSchemaType, TResult>[] | null {
  if (cached.parametersByTool.length !== tools.length) {
    return null;
  }
  try {
    return tools.map((tool, index) => {
      const cachedTool = cached.parametersByTool[index];
      if (!cachedTool || cachedTool.name !== tool.name) {
        throw new Error("provider_tool_schema_cache_tool_mismatch");
      }
      return {
        ...tool,
        parameters: cloneSchemaValue(cachedTool.parameters) as TSchemaType,
      };
    });
  } catch {
    return null;
  }
}

function buildProviderToolSchemaCacheKey(
  params: ProviderToolSchemaParams,
  provider: string,
  compatCacheKey: string,
): string | null {
  try {
    return createPluginCacheKey([
      "provider-tool-schema",
      PROVIDER_TOOL_SCHEMA_CACHE_VERSION,
      compatCacheKey,
      provider,
      normalizeCacheString(params.modelId),
      normalizeCacheString(params.modelApi),
      normalizeCacheString(params.model?.provider),
      normalizeCacheString(params.model?.api),
      normalizeCacheString(params.model?.baseUrl),
      params.tools.map((tool) => ({
        name: tool.name,
        parameters: stableJsonString(tool.parameters),
      })),
    ]);
  } catch {
    return null;
  }
}

function canResolveProviderToolSchemaCacheKey(params: ProviderToolSchemaParams): boolean {
  return params.allowRuntimePluginLoad !== false || params.runtimeHandle !== undefined;
}

export function resetProviderToolSchemaCacheForTest(): void {
  providerToolSchemaCache.clear();
  providerToolSchemaCache.setMaxEntriesForTest();
  providerToolSchemaCacheStats.bypass = 0;
  providerToolSchemaCacheStats.hit = 0;
  providerToolSchemaCacheStats.miss = 0;
  providerToolSchemaCacheStats.store = 0;
}

export function setProviderToolSchemaCacheMaxEntriesForTest(value?: number): void {
  providerToolSchemaCache.setMaxEntriesForTest(value);
}

export function getProviderToolSchemaCacheStatsForTest(): ProviderToolSchemaCacheStats & {
  size: number;
} {
  return {
    ...providerToolSchemaCacheStats,
    size: providerToolSchemaCache.size,
  };
}

/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
export function normalizeProviderToolSchemas<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const provider = params.provider.trim();
  const context = buildProviderToolSchemaContext(params, provider);
  const compatCacheKey = canResolveProviderToolSchemaCacheKey(params)
    ? resolveProviderToolSchemaNormalizeCacheKey({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        runtimeHandle: params.runtimeHandle,
        context,
      })
    : null;
  const cacheKey = compatCacheKey
    ? buildProviderToolSchemaCacheKey(params, provider, compatCacheKey)
    : null;
  if (cacheKey) {
    const cached = providerToolSchemaCache.get(cacheKey);
    if (cached) {
      const cachedTools = applyCachedToolParameters(params.tools, cached);
      if (cachedTools) {
        providerToolSchemaCacheStats.hit += 1;
        return cachedTools;
      }
    }
    providerToolSchemaCacheStats.miss += 1;
  } else {
    providerToolSchemaCacheStats.bypass += 1;
  }

  const pluginNormalized = normalizeProviderToolSchemasWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context,
  });
  const normalized = Array.isArray(pluginNormalized)
    ? (pluginNormalized as AgentTool<TSchemaType, TResult>[])
    : params.tools;
  if (cacheKey && Array.isArray(pluginNormalized)) {
    const cached = cloneToolParametersForCache(normalized);
    if (cached) {
      providerToolSchemaCache.set(cacheKey, cached);
      providerToolSchemaCacheStats.store += 1;
    }
  }
  return normalized;
}

/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void {
  const provider = params.provider.trim();
  const diagnostics = inspectProviderToolSchemasWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context: buildProviderToolSchemaContext(params, provider),
  });
  if (!Array.isArray(diagnostics)) {
    return;
  }
  if (diagnostics.length === 0) {
    return;
  }

  const summary = summarizeProviderToolSchemaDiagnostics(diagnostics);
  log.warn(
    `provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`,
    {
      provider: params.provider,
      toolCount: params.tools.length,
      diagnosticCount: diagnostics.length,
      tools: params.tools.map((tool, index) => `${index}:${tool.name}`),
      diagnostics: diagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violations.length;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
