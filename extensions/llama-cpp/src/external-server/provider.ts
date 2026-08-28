import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  resolveLlamaServerRuntimeApiKey,
} from "./auth.js";
import { discoverLlamaServer } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

/** Discovers external llama-server models for provider runtime resolution. */
export async function discoverLlamaServerProvider(
  ctx: ProviderCatalogContext,
): Promise<{ provider: ModelProviderConfig } | null> {
  const configured = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const auth = ctx.resolveProviderApiKey(LLAMA_CPP_PROVIDER_ID);
  const headers = await resolveLlamaServerProviderHeaders({
    config: ctx.config,
    env: ctx.env,
    headers: configured?.headers,
  });
  const discovery = await discoverLlamaServer({
    baseUrl: configured?.baseUrl,
    apiKey: hasLlamaServerAuthorizationHeader(headers)
      ? undefined
      : (auth.discoveryApiKey ?? auth.apiKey),
    headers,
  });
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

export async function prepareLlamaServerDynamicModel(
  ctx: ProviderPrepareDynamicModelContext,
): Promise<ProviderRuntimeModel | undefined> {
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
  const model =
    discovery.kind === "success"
      ? discovery.models.find((entry) => entry.config.id === ctx.modelId)
      : undefined;
  if (!model) {
    return undefined;
  }
  return {
    ...model.config,
    provider: LLAMA_CPP_PROVIDER_ID,
    api: ctx.providerConfig?.api ?? "openai-completions",
    baseUrl: resolveLlamaServerEndpoint(ctx.providerConfig?.baseUrl).inferenceBaseUrl,
    input: model.config.input.filter(
      (entry): entry is "text" | "image" => entry === "text" || entry === "image",
    ),
  };
}
