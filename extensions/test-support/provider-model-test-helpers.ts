import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderCatalogContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createProviderDynamicModelContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
}

export async function runSingleProviderCatalog(
  provider: Pick<ProviderPlugin, "catalog">,
  params: {
    resolveProviderApiKey?: ProviderCatalogContext["resolveProviderApiKey"];
    resolveProviderAuth?: ProviderCatalogContext["resolveProviderAuth"];
  } = {},
) {
  if (!provider.catalog) {
    throw new Error("expected provider catalog");
  }

  const catalog = await provider.catalog.run({
    config: {},
    env: {},
    resolveProviderApiKey: params.resolveProviderApiKey ?? (() => ({ apiKey: "test-key" })),
    resolveProviderAuth:
      params.resolveProviderAuth ??
      (() => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      })),
  } as ProviderCatalogContext);

  if (!catalog || !("provider" in catalog)) {
    throw new Error("expected single-provider catalog");
  }
  return catalog.provider;
}
