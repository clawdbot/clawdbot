// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/telegram/contract-api.js");
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "telegram",
    artifactBasename: "contract-api.js",
  });
}

export const parseTelegramTopicConversation: FacadeModule["parseTelegramTopicConversation"] = ((
  ...args
) =>
  loadFacadeModule().parseTelegramTopicConversation(
    ...args,
  )) as FacadeModule["parseTelegramTopicConversation"];

export const singleAccountKeysToMove: FacadeModule["singleAccountKeysToMove"] =
  createLazyFacadeArrayValue(() => loadFacadeModule().singleAccountKeysToMove);

export const collectTelegramSecurityAuditFindings: FacadeModule["collectTelegramSecurityAuditFindings"] =
  ((...args) =>
    loadFacadeModule().collectTelegramSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectTelegramSecurityAuditFindings"];

export const mergeTelegramAccountConfig: FacadeModule["mergeTelegramAccountConfig"] = ((...args) =>
  loadFacadeModule().mergeTelegramAccountConfig(
    ...args,
  )) as FacadeModule["mergeTelegramAccountConfig"];
