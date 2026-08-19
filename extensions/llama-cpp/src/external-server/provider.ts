import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  resolveLlamaServerRuntimeApiKey,
} from "./auth.js";
import { discoverLlamaServer, type LlamaServerDiscoveryResult } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig, type LlamaServerDiscoveredModel } from "./models.js";

const dynamicModels = new Map<string, ProviderRuntimeModel[]>();
const LLAMA_SERVER_DYNAMIC_MODEL_MAX_SCOPES = 100;

function cacheDynamicModels(key: string, models: ProviderRuntimeModel[]): void {
  dynamicModels.delete(key);
  dynamicModels.set(key, models);
  pruneMapToMaxSize(dynamicModels, LLAMA_SERVER_DYNAMIC_MODEL_MAX_SCOPES);
}

function dynamicModelScopeKey(
  ctx: Pick<
    ProviderResolveDynamicModelContext,
    "agentRuntimeId" | "agentDir" | "authProfileId" | "providerConfig"
  >,
): string {
  return [
    ctx.agentRuntimeId ?? ctx.agentDir ?? "",
    ctx.authProfileId ?? "",
    ctx.providerConfig?.baseUrl ?? "",
  ].join("\u0000");
}

function toRuntimeModel(
  model: LlamaServerDiscoveredModel,
  providerConfig: {
    baseUrl?: string;
    api?: ProviderRuntimeModel["api"];
  },
): ProviderRuntimeModel {
  return {
    ...model.config,
    provider: LLAMA_CPP_PROVIDER_ID,
    api: providerConfig.api ?? "openai-completions",
    baseUrl: resolveLlamaServerEndpoint(providerConfig.baseUrl).inferenceBaseUrl,
    input: model.config.input.filter(
      (entry): entry is "text" | "image" => entry === "text" || entry === "image",
    ),
  };
}

function statusWarning(model: LlamaServerDiscoveredModel): string | undefined {
  if (model.failed) {
    return model.exitCode
      ? `llama-server model process failed with exit code ${model.exitCode}`
      : "llama-server model process failed";
  }
  return model.status === "loaded" || model.status === "unknown"
    ? undefined
    : `llama-server model is ${model.status}`;
}

function toUnifiedCatalogEntry(
  model: LlamaServerDiscoveredModel,
  fetchedAt: number,
): UnifiedModelCatalogEntry {
  const warning = statusWarning(model);
  return {
    kind: "text",
    provider: LLAMA_CPP_PROVIDER_ID,
    model: model.config.id,
    label: model.config.name,
    source: "live",
    fetchedAt,
    capabilities: {
      input: model.config.input,
      reasoning: model.config.reasoning,
      contextWindow: model.config.contextWindow,
      contextTokens: model.config.contextTokens,
      maxTokens: model.config.maxTokens,
      status: model.status,
      buildInfo: model.buildInfo,
      totalSlots: model.totalSlots,
    },
    ...(warning ? { warnings: [warning] } : {}),
  };
}

async function discoverFromCatalogContext(
  ctx: ProviderCatalogContext | UnifiedModelCatalogProviderContext,
): Promise<LlamaServerDiscoveryResult> {
  const providerConfig = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const auth = ctx.resolveProviderApiKey(LLAMA_CPP_PROVIDER_ID);
  const headers = await resolveLlamaServerProviderHeaders({
    config: ctx.config,
    env: ctx.env,
    headers: providerConfig?.headers,
  });
  return await discoverLlamaServer({
    baseUrl: providerConfig?.baseUrl,
    apiKey: hasLlamaServerAuthorizationHeader(headers)
      ? undefined
      : (auth.discoveryApiKey ?? auth.apiKey),
    headers,
    signal: "signal" in ctx ? ctx.signal : undefined,
    timeoutMs: "timeoutMs" in ctx ? ctx.timeoutMs : undefined,
  });
}

/** Legacy text runtime catalog until the unified loader owns model resolution. */
export async function discoverLlamaServerProvider(
  ctx: ProviderCatalogContext,
): Promise<{ provider: ModelProviderConfig } | null> {
  const configured = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const discovery = await discoverFromCatalogContext(ctx);
  if (discovery.kind !== "success") {
    return configured
      ? {
          provider: buildLlamaServerProviderConfig({
            configured,
            discoveredModels: [],
          }),
        }
      : null;
  }
  return {
    provider: buildLlamaServerProviderConfig({
      configured: {
        ...configured,
        baseUrl: discovery.endpoint.inferenceBaseUrl,
        models: configured?.models ?? [],
      },
      discoveredModels: discovery.models,
    }),
  };
}

/** Live rows for model pickers and other unified catalog consumers. */
export async function listLlamaServerCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<UnifiedModelCatalogEntry[]> {
  if (ctx.includeLive === false) {
    return [];
  }
  const discovery = await discoverFromCatalogContext(ctx);
  return discovery.kind === "success"
    ? discovery.models.map((model) => toUnifiedCatalogEntry(model, discovery.fetchedAt))
    : [];
}

export async function prepareLlamaServerDynamicModels(
  ctx: ProviderPrepareDynamicModelContext,
): Promise<void> {
  const apiKey = await resolveLlamaServerRuntimeApiKey({
    config: ctx.config,
    agentDir: ctx.agentDir,
    profileId: ctx.authProfileId,
  });
  const headers = await resolveLlamaServerProviderHeaders({
    config: ctx.config,
    env: process.env,
    headers: ctx.providerConfig?.headers,
  });
  const discovery = await discoverLlamaServer({
    baseUrl: ctx.providerConfig?.baseUrl,
    apiKey: hasLlamaServerAuthorizationHeader(headers) ? undefined : apiKey,
    headers,
    cacheTtlMs: 0,
  });
  const key = dynamicModelScopeKey(ctx);
  cacheDynamicModels(
    key,
    discovery.kind === "success"
      ? discovery.models.map((model) => toRuntimeModel(model, ctx.providerConfig ?? {}))
      : [],
  );
}

export function resolveLlamaServerDynamicModel(
  params: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return dynamicModels
    .get(dynamicModelScopeKey(params))
    ?.find((model) => model.id === params.modelId);
}
