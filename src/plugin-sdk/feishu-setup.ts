// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/feishu/setup-api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "feishu",
    artifactBasename: "setup-api.js",
  });
}
export const feishuSetupAdapter: FacadeModule["feishuSetupAdapter"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["feishuSetupAdapter"] as object,
) as FacadeModule["feishuSetupAdapter"];
export const feishuSetupWizard: FacadeModule["feishuSetupWizard"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["feishuSetupWizard"] as object,
) as FacadeModule["feishuSetupWizard"];
