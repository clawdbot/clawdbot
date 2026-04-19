// Manual facade. Keep loader boundary explicit.
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type FacadeModule = {
  feishuSetupAdapter: ChannelSetupAdapter;
  feishuSetupWizard: ChannelSetupWizard;
};

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
