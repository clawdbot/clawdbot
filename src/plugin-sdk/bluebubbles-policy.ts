// Manual facade. Keep loader boundary explicit.
import type { OpenClawConfig } from "../config/types.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type BlueBubblesGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type FacadeModule = {
  isAllowedBlueBubblesSender: (params: {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
  }) => boolean;
  resolveBlueBubblesGroupRequireMention: (params: BlueBubblesGroupContext) => boolean;
  resolveBlueBubblesGroupToolPolicy: (
    params: BlueBubblesGroupContext,
  ) => GroupToolPolicyConfig | undefined;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "bluebubbles",
    artifactBasename: "api.js",
  });
}
export const isAllowedBlueBubblesSender: FacadeModule["isAllowedBlueBubblesSender"] = ((...args) =>
  loadFacadeModule()["isAllowedBlueBubblesSender"](
    ...args,
  )) as FacadeModule["isAllowedBlueBubblesSender"];
export const resolveBlueBubblesGroupRequireMention: FacadeModule["resolveBlueBubblesGroupRequireMention"] =
  ((...args) =>
    loadFacadeModule()["resolveBlueBubblesGroupRequireMention"](
      ...args,
    )) as FacadeModule["resolveBlueBubblesGroupRequireMention"];
export const resolveBlueBubblesGroupToolPolicy: FacadeModule["resolveBlueBubblesGroupToolPolicy"] =
  ((...args) =>
    loadFacadeModule()["resolveBlueBubblesGroupToolPolicy"](
      ...args,
    )) as FacadeModule["resolveBlueBubblesGroupToolPolicy"];
