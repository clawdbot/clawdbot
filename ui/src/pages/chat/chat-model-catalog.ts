import type { ModelCatalogEntry } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";

export type ChatModelCatalogMode = "replace";

type WritableChatModelCatalog = {
  chatModelCatalog: ModelCatalogEntry[];
  chatModelCatalogMode?: ChatModelCatalogMode;
};

export function applyChatModelCatalog(
  state: WritableChatModelCatalog,
  models: ModelCatalogEntry[],
  catalogMode?: ChatModelCatalogMode,
) {
  state.chatModelCatalog = models;
  state.chatModelCatalogMode = catalogMode;
}

export function clearChatModelCatalog(state: WritableChatModelCatalog) {
  state.chatModelCatalog = [];
  state.chatModelCatalogMode = undefined;
}

export function replaceModeModelSettingsHref(
  catalogMode: ChatModelCatalogMode | undefined,
  basePath: string,
): string | undefined {
  return catalogMode === "replace"
    ? pathForRoute("model-providers", basePath)
    : undefined;
}
