// Manual facade. Keep loader boundaries explicit and narrow.
type SetupFacadeModule = typeof import("@openclaw/zalo/setup-api.js");
type GroupAccessFacadeModule = typeof import("@openclaw/zalo/contract-api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadSetupFacadeModule(): SetupFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<SetupFacadeModule>({
    dirName: "zalo",
    artifactBasename: "setup-api.js",
  });
}
function loadGroupAccessFacadeModule(): GroupAccessFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<GroupAccessFacadeModule>({
    dirName: "zalo",
    artifactBasename: "contract-api.js",
  });
}

export const evaluateZaloGroupAccess: GroupAccessFacadeModule["evaluateZaloGroupAccess"] = ((
  ...args
) =>
  loadGroupAccessFacadeModule()["evaluateZaloGroupAccess"](
    ...args,
  )) as GroupAccessFacadeModule["evaluateZaloGroupAccess"];
export const resolveZaloRuntimeGroupPolicy: GroupAccessFacadeModule["resolveZaloRuntimeGroupPolicy"] =
  ((...args) =>
    loadGroupAccessFacadeModule()["resolveZaloRuntimeGroupPolicy"](
      ...args,
    )) as GroupAccessFacadeModule["resolveZaloRuntimeGroupPolicy"];
export const zaloSetupAdapter: SetupFacadeModule["zaloSetupAdapter"] = createLazyFacadeObjectValue(
  () => loadSetupFacadeModule()["zaloSetupAdapter"] as object,
) as SetupFacadeModule["zaloSetupAdapter"];
export const zaloSetupWizard: SetupFacadeModule["zaloSetupWizard"] = createLazyFacadeObjectValue(
  () => loadSetupFacadeModule()["zaloSetupWizard"] as object,
) as SetupFacadeModule["zaloSetupWizard"];
