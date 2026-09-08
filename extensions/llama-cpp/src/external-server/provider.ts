import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import * as liveCatalogRuntime from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  resolveLlamaServerRuntimeApiKey,
} from "./auth.js";
import { discoverLlamaServer } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

// Published 2026.9.2 understands catalog outcomes but does not export this runner.
// Remove this fallback when the declared plugin API floor excludes that host.
const liveCatalogSdk: Partial<Pick<typeof liveCatalogRuntime, "runLiveProviderCatalog">> =
  liveCatalogRuntime;
type CatalogOutcome = NonNullable<NonNullable<ProviderCatalogResult>["outcomes"]>[number];

async function runLlamaServerCatalog(
  params: Parameters<typeof liveCatalogRuntime.runLiveProviderCatalog>[0],
): Promise<ProviderCatalogResult> {
  if (liveCatalogSdk.runLiveProviderCatalog) {
    return await liveCatalogSdk.runLiveProviderCatalog(params);
  }
  const identity = {
    provider: params.providerId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
  };
  try {
    const result = await params.run();
    return result
      ? { ...result, outcomes: [...(result.outcomes ?? []), { ...identity, status: "ready" }] }
      : result;
  } catch (error) {
    const rejected =
      error instanceof liveCatalogRuntime.LiveModelCatalogHttpError &&
      (error.status === 401 || error.status === 403);
    const outcome: CatalogOutcome = rejected
      ? { ...identity, status: "auth-rejected", rejectionScope: "catalog" }
      : { ...identity, status: "unavailable" };
    return { providers: {}, outcomes: [outcome] };
  }
}

/** Discovers external llama-server models for provider runtime resolution. */
export async function discoverLlamaServerProvider(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  const configured = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const auth = ctx.resolveProviderApiKey(LLAMA_CPP_PROVIDER_ID);
  const headers = await resolveLlamaServerProviderHeaders({
    config: ctx.config,
    env: ctx.env,
    headers: configured?.headers,
  });
  const authApiKey = auth.discoveryApiKey ?? auth.apiKey;
  const apiKey =
    hasLlamaServerAuthorizationHeader(headers) ||
    (authApiKey && isNonSecretApiKeyMarker(authApiKey))
      ? undefined
      : authApiKey;
  return await runLlamaServerCatalog({
    providerId: LLAMA_CPP_PROVIDER_ID,
    profileId: apiKey ? auth.profileId : undefined,
    run: async () => {
      const discovery = await discoverLlamaServer({
        baseUrl: configured?.baseUrl,
        apiKey,
        headers,
        cacheTtlMs: 0,
      });
      if (discovery.kind !== "success") {
        if (!configured && !apiKey && !headers) {
          return null;
        }
        throw discovery.kind === "http-error"
          ? new liveCatalogRuntime.LiveModelCatalogHttpError(
              LLAMA_CPP_PROVIDER_ID,
              discovery.status,
            )
          : discovery.error;
      }
      return {
        provider: buildLlamaServerProviderConfig({
          configured,
          discoveredModels: discovery.models,
        }),
      };
    },
  });
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
