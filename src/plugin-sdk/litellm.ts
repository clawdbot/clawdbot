// Manual facade. Keep loader boundary explicit.
import type { ModelDefinitionConfig, OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  applyLitellmConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  applyLitellmProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  buildLitellmModelDefinition: () => ModelDefinitionConfig;
  LITELLM_BASE_URL: string;
  LITELLM_DEFAULT_MODEL_ID: string;
  LITELLM_DEFAULT_MODEL_REF: string;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "litellm",
    artifactBasename: "api.js",
  });
}
export const applyLitellmConfig: FacadeModule["applyLitellmConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmConfig"](...args)) as FacadeModule["applyLitellmConfig"];
export const applyLitellmProviderConfig: FacadeModule["applyLitellmProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyLitellmProviderConfig"](
    ...args,
  )) as FacadeModule["applyLitellmProviderConfig"];
export const buildLitellmModelDefinition: FacadeModule["buildLitellmModelDefinition"] = ((
  ...args
) =>
  loadFacadeModule()["buildLitellmModelDefinition"](
    ...args,
  )) as FacadeModule["buildLitellmModelDefinition"];
export const LITELLM_BASE_URL: FacadeModule["LITELLM_BASE_URL"] =
  loadFacadeModule()["LITELLM_BASE_URL"];
export const LITELLM_DEFAULT_MODEL_ID: FacadeModule["LITELLM_DEFAULT_MODEL_ID"] =
  loadFacadeModule()["LITELLM_DEFAULT_MODEL_ID"];
export const LITELLM_DEFAULT_MODEL_REF: FacadeModule["LITELLM_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["LITELLM_DEFAULT_MODEL_REF"];
