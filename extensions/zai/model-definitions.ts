import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
export const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZAI_DEFAULT_MODEL_ID = "glm-5.1";
export const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;

const ZAI_MANIFEST_CATALOG = manifest.modelCatalog.providers.zai;
const ZAI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "zai",
  catalog: ZAI_MANIFEST_CATALOG,
});
const ZAI_MODEL_CATALOG = new Map(
  ZAI_MANIFEST_PROVIDER.models.map((model) => [model.id, model] as const),
);

export const ZAI_DEFAULT_COST =
  ZAI_MODEL_CATALOG.get("glm-5")?.cost ??
  ({
    input: 1,
    output: 3.2,
    cacheRead: 0.2,
    cacheWrite: 0,
  } satisfies ModelDefinitionConfig["cost"]);

export function resolveZaiBaseUrl(endpoint?: string): string {
  switch (endpoint) {
    case "coding-cn":
      return ZAI_CODING_CN_BASE_URL;
    case "global":
      return ZAI_GLOBAL_BASE_URL;
    case "cn":
      return ZAI_CN_BASE_URL;
    case "coding-global":
      return ZAI_CODING_GLOBAL_BASE_URL;
    default:
      return ZAI_GLOBAL_BASE_URL;
  }
}

export function buildZaiCatalogModels(): ModelDefinitionConfig[] {
  return ZAI_MANIFEST_PROVIDER.models.map((model) =>
    Object.assign({}, model, { input: [...model.input] }),
  );
}

export function buildZaiModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ModelDefinitionConfig["input"];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = ZAI_MODEL_CATALOG.get(params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? true,
    input:
      params.input ?? (catalog?.input ? ([...catalog.input] as ("text" | "image")[]) : ["text"]),
    cost: params.cost ?? catalog?.cost ?? ZAI_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 202800,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 131100,
  };
}
