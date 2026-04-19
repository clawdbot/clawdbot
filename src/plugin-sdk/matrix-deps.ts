// Manual facade. Keep loader boundary explicit.
import type { RuntimeEnv } from "../runtime.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  ensureMatrixSdkInstalled: (params: {
    runtime: RuntimeEnv;
    confirm?: (message: string) => Promise<boolean>;
  }) => Promise<void>;
  isMatrixSdkAvailable: () => boolean;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "runtime-api.js",
  });
}

export const ensureMatrixSdkInstalled: FacadeModule["ensureMatrixSdkInstalled"] = ((...args) =>
  loadFacadeModule().ensureMatrixSdkInstalled(...args)) as FacadeModule["ensureMatrixSdkInstalled"];
export const isMatrixSdkAvailable: FacadeModule["isMatrixSdkAvailable"] = ((...args) =>
  loadFacadeModule().isMatrixSdkAvailable(...args)) as FacadeModule["isMatrixSdkAvailable"];
