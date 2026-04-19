// Manual facade. Keep loader boundary explicit.
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  applyXiaomiConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  applyXiaomiProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  buildXiaomiProvider: () => ModelProviderConfig;
  XIAOMI_DEFAULT_MODEL_ID: string;
  XIAOMI_DEFAULT_MODEL_REF: string;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "xiaomi",
    artifactBasename: "api.js",
  });
}
export const applyXiaomiConfig: FacadeModule["applyXiaomiConfig"] = ((...args) =>
  loadFacadeModule()["applyXiaomiConfig"](...args)) as FacadeModule["applyXiaomiConfig"];
export const applyXiaomiProviderConfig: FacadeModule["applyXiaomiProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyXiaomiProviderConfig"](
    ...args,
  )) as FacadeModule["applyXiaomiProviderConfig"];
export const buildXiaomiProvider: FacadeModule["buildXiaomiProvider"] = ((...args) =>
  loadFacadeModule()["buildXiaomiProvider"](...args)) as FacadeModule["buildXiaomiProvider"];
export const XIAOMI_DEFAULT_MODEL_ID: FacadeModule["XIAOMI_DEFAULT_MODEL_ID"] =
  loadFacadeModule()["XIAOMI_DEFAULT_MODEL_ID"];
export const XIAOMI_DEFAULT_MODEL_REF: FacadeModule["XIAOMI_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["XIAOMI_DEFAULT_MODEL_REF"];
