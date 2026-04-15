import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelProviderConfig } from "../config/types.models.js";

export * from "./provider-catalog.js";
export type { ProviderCatalogContext, ProviderCatalogResult } from "./provider-catalog.js";

function normalizeConfiguredModelInput(input: unknown): ModelCatalogEntry["input"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is "text" | "image" | "document" =>
      item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function readConfiguredProviderCatalogEntries(params: {
  config: OpenClawConfig | undefined;
  providerId: string;
}): ModelCatalogEntry[] {
  const providerConfig = params.config?.models?.providers?.[params.providerId];
  if (!providerConfig || !Array.isArray(providerConfig.models)) {
    return [];
  }

  return providerConfig.models.flatMap((model): ModelCatalogEntry[] => {
    if (!model || typeof model !== "object" || typeof model.id !== "string") {
      return [];
    }
    const id = model.id.trim();
    if (!id) {
      return [];
    }
    const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    const contextWindow =
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : undefined;
    const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
    return [
      {
        id,
        name,
        provider: params.providerId,
        contextWindow,
        reasoning,
        input: normalizeConfiguredModelInput(model.input),
      },
    ];
  });
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return baseUrl?.trim().toLowerCase() ?? "";
}

export function supportsNativeStreamingUsageCompat(params: {
  providerId: string;
  baseUrl: string | undefined;
}): boolean {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return false;
  }

  switch (params.providerId) {
    case "moonshot":
      return normalized.includes("moonshot.ai") || normalized.includes("moonshot.cn");
    case "qwen":
      return (
        normalized.includes("dashscope.aliyuncs.com") ||
        normalized.includes("dashscope-intl.aliyuncs.com")
      );
    default:
      return false;
  }
}

export function applyProviderNativeStreamingUsageCompat(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  if (
    !supportsNativeStreamingUsageCompat({
      providerId: params.providerId,
      baseUrl: params.providerConfig.baseUrl,
    })
  ) {
    return params.providerConfig;
  }

  return {
    ...params.providerConfig,
    models: params.providerConfig.models.map((model) => ({
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    })),
  };
}
