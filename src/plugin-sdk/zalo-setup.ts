// Manual facade. Keep loader boundaries explicit and narrow.
import type { ChannelSetupWizard } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupAdapter } from "../channels/plugins/types.adapters.js";
import type { GroupPolicy } from "../config/types.base.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";
import type { SenderGroupAccessDecision } from "./group-access.js";

type ZaloRuntimeGroupPolicyResult = {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};

type SetupFacadeModule = {
  zaloSetupAdapter: ChannelSetupAdapter;
  zaloSetupWizard: ChannelSetupWizard;
};

type GroupAccessFacadeModule = {
  evaluateZaloGroupAccess: (params: {
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
    groupAllowFrom: string[];
    senderId: string;
  }) => SenderGroupAccessDecision;
  resolveZaloRuntimeGroupPolicy: (params: {
    providerConfigPresent: boolean;
    groupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
  }) => ZaloRuntimeGroupPolicyResult;
};

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
