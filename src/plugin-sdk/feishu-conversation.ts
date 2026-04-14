// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/feishu/contract-api.js");
import {
  createLazyFacadeArrayValue,
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "feishu",
    artifactBasename: "contract-api.js",
  });
}
export const buildFeishuConversationId: FacadeModule["buildFeishuConversationId"] = ((...args) =>
  loadFacadeModule()["buildFeishuConversationId"](
    ...args,
  )) as FacadeModule["buildFeishuConversationId"];
export const createFeishuThreadBindingManager: FacadeModule["createFeishuThreadBindingManager"] = ((
  ...args
) =>
  loadFacadeModule()["createFeishuThreadBindingManager"](
    ...args,
  )) as FacadeModule["createFeishuThreadBindingManager"];
export const feishuSessionBindingAdapterChannels: FacadeModule["feishuSessionBindingAdapterChannels"] =
  createLazyFacadeArrayValue(
    () =>
      loadFacadeModule()["feishuSessionBindingAdapterChannels"] as unknown as readonly unknown[],
  ) as FacadeModule["feishuSessionBindingAdapterChannels"];
export const feishuThreadBindingTesting: FacadeModule["feishuThreadBindingTesting"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["feishuThreadBindingTesting"] as object,
  ) as FacadeModule["feishuThreadBindingTesting"];
export const parseFeishuDirectConversationId: FacadeModule["parseFeishuDirectConversationId"] = ((
  ...args
) =>
  loadFacadeModule()["parseFeishuDirectConversationId"](
    ...args,
  )) as FacadeModule["parseFeishuDirectConversationId"];
export const parseFeishuConversationId: FacadeModule["parseFeishuConversationId"] = ((...args) =>
  loadFacadeModule()["parseFeishuConversationId"](
    ...args,
  )) as FacadeModule["parseFeishuConversationId"];
export const parseFeishuTargetId: FacadeModule["parseFeishuTargetId"] = ((...args) =>
  loadFacadeModule()["parseFeishuTargetId"](...args)) as FacadeModule["parseFeishuTargetId"];
