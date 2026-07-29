// Manual facade. Keep loader boundary explicit.
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  applyOpenrouterConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  applyOpenrouterProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  buildOpenrouterProvider: () => ModelProviderConfig;
  OPENROUTER_DEFAULT_MODEL_REF: string;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "openrouter",
    artifactBasename: "api.js",
  });
}
/** Apply OpenRouter defaults to the full OpenClaw config. */
export const applyOpenrouterConfig: FacadeModule["applyOpenrouterConfig"] = ((...args) =>
  loadFacadeModule()["applyOpenrouterConfig"](...args)) as FacadeModule["applyOpenrouterConfig"];
/** Apply only OpenRouter provider config defaults. */
export const applyOpenrouterProviderConfig: FacadeModule["applyOpenrouterProviderConfig"] = ((
  ...args
) =>
  loadFacadeModule()["applyOpenrouterProviderConfig"](
    ...args,
  )) as FacadeModule["applyOpenrouterProviderConfig"];
/** Build the OpenRouter model provider entry used by setup/config helpers. */
export const buildOpenrouterProvider: FacadeModule["buildOpenrouterProvider"] = ((...args) =>
  loadFacadeModule()["buildOpenrouterProvider"](
    ...args,
  )) as FacadeModule["buildOpenrouterProvider"];
/** Default OpenRouter provider/model reference written by setup flows. */
export const OPENROUTER_DEFAULT_MODEL_REF: FacadeModule["OPENROUTER_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["OPENROUTER_DEFAULT_MODEL_REF"];
