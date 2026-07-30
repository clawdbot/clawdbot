import type { ModelCatalogEntry } from "../../api/types.ts";

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
