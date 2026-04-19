// Manual facade. Keep loader boundary explicit.
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type ModelCost = ModelDefinitionConfig["cost"];

type FacadeModule = {
  buildVercelAiGatewayProvider: () => Promise<ModelProviderConfig>;
  discoverVercelAiGatewayModels: () => Promise<ModelDefinitionConfig[]>;
  getStaticVercelAiGatewayModelCatalog: () => ModelDefinitionConfig[];
  VERCEL_AI_GATEWAY_BASE_URL: string;
  VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW: number;
  VERCEL_AI_GATEWAY_DEFAULT_COST: ModelCost;
  VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS: number;
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID: string;
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF: string;
  VERCEL_AI_GATEWAY_PROVIDER_ID: string;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "vercel-ai-gateway",
    artifactBasename: "api.js",
  });
}
export const buildVercelAiGatewayProvider: FacadeModule["buildVercelAiGatewayProvider"] = ((
  ...args
) =>
  loadFacadeModule()["buildVercelAiGatewayProvider"](
    ...args,
  )) as FacadeModule["buildVercelAiGatewayProvider"];
export const discoverVercelAiGatewayModels: FacadeModule["discoverVercelAiGatewayModels"] = ((
  ...args
) =>
  loadFacadeModule()["discoverVercelAiGatewayModels"](
    ...args,
  )) as FacadeModule["discoverVercelAiGatewayModels"];
export const getStaticVercelAiGatewayModelCatalog: FacadeModule["getStaticVercelAiGatewayModelCatalog"] =
  ((...args) =>
    loadFacadeModule()["getStaticVercelAiGatewayModelCatalog"](
      ...args,
    )) as FacadeModule["getStaticVercelAiGatewayModelCatalog"];
export const VERCEL_AI_GATEWAY_BASE_URL: FacadeModule["VERCEL_AI_GATEWAY_BASE_URL"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_BASE_URL"];
export const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW"];
export const VERCEL_AI_GATEWAY_DEFAULT_COST: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_COST"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_COST"] as object,
  ) as FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_COST"];
export const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS"];
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID"];
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF: FacadeModule["VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF"];
export const VERCEL_AI_GATEWAY_PROVIDER_ID: FacadeModule["VERCEL_AI_GATEWAY_PROVIDER_ID"] =
  loadFacadeModule()["VERCEL_AI_GATEWAY_PROVIDER_ID"];
